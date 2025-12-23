import json
import boto3
import os
import zipfile
import tempfile
import base64
import urllib.request
import time
import random
import re
import hashlib
from typing import List, Dict
from concurrent.futures import ThreadPoolExecutor, as_completed
from botocore.config import Config

# 1. Configuration
bedrock_config = Config(retries={'max_attempts': 15, 'mode': 'adaptive'}, connect_timeout=10, read_timeout=300)
bedrock = boto3.client('bedrock-runtime', config=bedrock_config)
s3 = boto3.client("s3")

MAX_CHARS_PER_CHUNK = 100000 
MAX_WORKERS = 10 
RELEVANT_EXTENSIONS = (".md", ".yaml", ".yml", ".json", ".py", ".java", ".ts", ".js", ".tf", ".sh", ".tsx", ".properties", ".go", ".cs", ".xml", ".gradle", ".sql")
IGNORE_DIRS = {'node_modules', 'venv', '.git', 'dist', 'build', 'target', '__pycache__', 'tests', 'test', 'bin', 'obj'}

BITBUCKET_BASE = "https://api.bitbucket.org/2.0/repositories"
BITBUCKET_ARCHIVE_BASE = "https://bitbucket.org"
BRANCH = "master"

# =====================
# Improved Mermaid Processor
# =====================

def process_html_content(text: str) -> str:
    """
    Finds all Mermaid blocks and converts each one individually into a unique SVG link.
    """
    # Pattern to find all mermaid code blocks
    pattern = r'```mermaid\s*([\s\S]*?)\s*```'
    
    def replace_with_svg(match):
        mermaid_code = match.group(1).strip()
        # Clean potential LLM artifacts from inside the code
        mermaid_code = re.sub(r'#.*', '', mermaid_code) # remove comments if they break link
        
        # Base64 encode for mermaid.ink
        encoded_bytes = base64.b64encode(mermaid_code.encode('utf-8'))
        encoded_str = encoded_bytes.decode('utf-8')
        
        return f'<div style="text-align:center; margin:30px 0;"><img src="https://mermaid.ink/svg/{encoded_str}" alt="API Sequence Diagram" style="max-width:100%; border:1px solid #eee; padding:10px; background:#fff;"/></div>'

    # Use re.sub with a callback function to ensure every match is processed uniquely
    text = re.sub(pattern, replace_with_svg, text, flags=re.DOTALL)
    
    # Cleanup Markdown
    text = re.sub(r'```[a-zA-Z]*', '', text)
    text = text.replace('```', '')
    text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
    text = re.sub(r'^#+\s+(.*)$', r'\1', text, flags=re.MULTILINE)
    
    return text

# =====================
# Bedrock Core
# =====================

def invoke_bedrock(prompt: str, max_tokens=4000) -> str:
    for attempt in range(6):
        try:
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0
            })
            response = bedrock.invoke_model(modelId="anthropic.claude-3-5-sonnet-20240620-v1:0", body=body)
            return json.loads(response["body"].read())["content"][0]["text"]
        except Exception as e:
            if "Throttling" in str(e):
                time.sleep((2 ** attempt) + random.random())
                continue
            return ""

def generate_section_worker(summaries, section_type):
    prompts = {
        "header": "<h2>Service Overview</h2><p>Provide a comprehensive narrative of the business logic.</p><h2>System Architecture</h2><p>Detail interactions. Use a ```mermaid\\ngraph TD\\n...``` block.</p><h2>Tech Stack</h2><p>HTML Table [Category, Technology, Usage].</p>",
        "apis": """
            <h2>API Details</h2>
            <p>CRITICAL: Identify and document EVERY SINGLE API endpoint found in the summaries. Do not skip any. For EACH endpoint provide:</p>
            <ul>
                <li>H3 Method and Path</li>
                <li>Detailed description</li>
                <li>Request Parameter Table</li>
                <li>Request JSON Sample (&lt;pre&gt;&lt;code&gt;)</li>
                <li>Response Table</li>
                <li>Response JSON Sample (&lt;pre&gt;&lt;code&gt;)</li>
                <li>A UNIQUE ```mermaid\\nsequenceDiagram\\n...``` for THIS endpoint.</li>
            </ul>
        """,
        "dao": "<h2>DAO Table Details</h2><p>Document every database table/schema. H3 Table Name and Column Table [Field, Type, Constraints, Description]. Skip DTOs.</p>",
        "security": "<h2>Security</h2><p>Provide a short bulleted list (ul/li) of implemented auth and security mechanisms. No tables.</p>",
        "observability": "<h2>Observability</h2><p>Sub-sections: Logging, Metrics, Exception Handling. Use tables if data exists.</p>",
        "setup": "<h2>Setup the Service</h2><h3>Prerequisites</h3><p>List software/env vars.</p><h3>Testing</h3><p>Provide cURL/Postman details based on auth.</p>",
        "recommendations": "<h2>Recommendations</h2><p>Narrative on logging and security improvements. No architecture proposals.</p>"
    }
    
    full_prompt = f"Context: {json.dumps(summaries)}\n\nTask: {prompts[section_type]}\n\nSTRICT RULES: Output ONLY HTML. Ensure ALL identified items are included. For diagrams, use ONLY ```mermaid code blocks."
    raw_response = invoke_bedrock(full_prompt, max_tokens=8000)
    return section_type, process_html_content(raw_response)

# =====================
# Lambda Handler
# =====================

def lambda_handler(event, context):
    body_data = event.get("body", event)
    if isinstance(body_data, str): body_data = json.loads(body_data)
    
    repo_name, workspace = body_data["repoName"], body_data["workspaceName"]
    username, token = body_data["orgAdminEmail"], body_data["bitbucketToken"]
    bucket = os.environ.get("archive_s3_bucket")

    auth_str = base64.b64encode(f"{username}:{token}".encode()).decode()
    
    # Cache Logic
    try:
        url = f"{BITBUCKET_BASE}/{workspace}/{repo_name}/src/{BRANCH}/"
        req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth_str}"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            commit_hash = json.loads(resp.read().decode())["values"][0]["commit"]["hash"]
        
        cache = s3.get_object(Bucket=bucket, Key=f"{commit_hash}.html")
        return {"statusCode": 200, "newHtmlContent": cache["Body"].read().decode("utf-8"), "cached": True}
    except: pass

    with tempfile.TemporaryDirectory() as tmp:
        # Download
        zip_url = f"{BITBUCKET_ARCHIVE_BASE}/{workspace}/{repo_name}/get/{BRANCH}.zip"
        req = urllib.request.Request(zip_url, headers={"Authorization": f"Basic {auth_str}"})
        zip_path = os.path.join(tmp, "repo.zip")
        with urllib.request.urlopen(req, timeout=60) as resp, open(zip_path, "wb") as f:
            f.write(resp.read())
        with zipfile.ZipFile(zip_path, "r") as z: z.extractall(tmp)
        
        # Load Files
        files = []
        for base, dirs, filenames in os.walk(tmp):
            dirs[:] = [d for d in dirs if d.lower() not in IGNORE_DIRS]
            for n in filenames:
                if any(n.endswith(ext) for ext in RELEVANT_EXTENSIONS):
                    p = os.path.join(base, n)
                    try:
                        with open(p, "r", encoding="utf-8", errors="ignore") as f:
                            c = f.read().strip()
                            if c: files.append({"path": os.path.relpath(p, tmp), "content": c})
                    except: continue

        chunks, current, size = [], [], 0
        for f in files:
            if size + len(f["content"]) > MAX_CHARS_PER_CHUNK and current:
                chunks.append(current); current, size = [], 0
            current.append(f); size += len(f["content"])
        if current: chunks.append(current)

        # Step 1: Deep Map (Fact Extraction)
        summaries = []
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as exe:
            # We use a very explicit prompt here to ensure no API is missed
            map_prompt = "ACT AS AN ANALYST. List EVERY SINGLE API endpoint, its full path, method, and a brief summary. List EVERY database table. Identify Security and Tech stack. Do not omit anything."
            futures = [exe.submit(invoke_bedrock, f"{map_prompt}\n\nFILES: {json.dumps(c)}") for c in chunks]
            for f in as_completed(futures): summaries.append(f.result())

        # Step 2: Final Section Generation (Stitch)
        section_results = {}
        sections = ["header", "apis", "dao", "security", "observability", "setup", "recommendations"]
        with ThreadPoolExecutor(max_workers=len(sections)) as exe:
            futures = [exe.submit(generate_section_worker, summaries, s) for s in sections]
            for f in as_completed(futures):
                s_type, html = f.result()
                section_results[s_type] = html

        # Final Formatting
        style = "<style>body{font-family:sans-serif; line-height:1.6; color:#333; max-width:1100px; margin:auto; padding:30px;} table{border-collapse:collapse; width:100%; margin:20px 0;} th,td{border:1px solid #ddd; padding:10px; text-align:left;} th{background:#f4f4f4;} pre{background:#f4f4f4; padding:15px; border-radius:5px; overflow:auto;} h2{border-bottom:2px solid #eee; padding-bottom:10px; margin-top:40px; color:#2c3e50;} h3{color:#34495e; background:#f9f9f9; padding:5px; border-left:4px solid #34495e;}</style>"
        
        body_content = "\n".join([section_results.get(s, "") for s in sections])
        final_html = f"{style}\n{body_content}"
        
        s3.put_object(Bucket=bucket, Key=f"{commit_hash}.html", Body=final_html.encode("utf-8"), ContentType="text/html")

    return {"statusCode": 200, "newHtmlContent": final_html, "newTitle": f"Docs: {repo_name}", "cached": False}
