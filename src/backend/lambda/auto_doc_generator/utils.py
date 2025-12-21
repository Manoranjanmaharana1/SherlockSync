import os
import json
import time
import random
import base64
import tempfile
import zipfile
import urllib.request

import boto3

# AWS clients
s3 = boto3.client("s3")
bedrock = boto3.client("bedrock-runtime")

# Constants
MAX_CHARS_PER_CHUNK = 7000
RELEVANT_EXTENSIONS = (
    ".md", ".yaml", ".yml", ".json",
    ".py", ".java", ".ts", ".js",
    ".tf", ".sh", ".css", ".tsx", ".properties"
)

BITBUCKET_BASE = "https://api.bitbucket.org/2.0/repositories"
BITBUCKET_ARCHIVE_BASE = "https://bitbucket.org"
BRANCH = "master"

CONTINUE_PROMPT = """
Continue EXACTLY from where you stopped.
Do NOT repeat content.
Return ONLY valid HTML body.
Close any open tags.
"""

# ------------------
# Bitbucket
# ------------------

def bitbucket_auth_header(username: str, bitbucketToken: str):
    """
    Build the Bitbucket Basic Auth header.

    Args:
        username (str): Bitbucket workspace username.
        bitbucketToken (str): Bitbucket app password or token.

    Returns:
        dict: HTTP headers with Basic Authorization for Bitbucket API.
    """
    auth = base64.b64encode(
        f"{username}:{bitbucketToken}".encode("utf-8")
    ).decode("utf-8")

    return {
        "Authorization": f"Basic {auth}",
        "Accept": "application/json"
    }


def fetch_diff(repo_name, workspace_name, username, bitbucketToken):
    """
    Fetch the latest commit hash and top diff from a Bitbucket repository.

    Args:
        repo_name (str): Name of the repository.
        workspace_name (str): Bitbucket workspace.
        username (str): Username for Bitbucket auth.
        bitbucketToken (str): Token for Bitbucket auth.

    Returns:
        tuple[str, str]: The commit hash and its diff.
    """
    url = f"{BITBUCKET_BASE}/{workspace_name}/{repo_name}/src/{BRANCH}/"
    req = urllib.request.Request(
        url, headers=bitbucket_auth_header(username, bitbucketToken)
    )

    commit_hash = None
    with urllib.request.urlopen(req, timeout=10) as response:
        data = json.loads(response.read().decode())

    for item in data.get("values", []):
        if item.get("type") == "commit_file":
            commit_hash = item["commit"]["hash"]
            break

    diff_url = f"{BITBUCKET_BASE}/{workspace_name}/{repo_name}/diff/{commit_hash}"
    req = urllib.request.Request(
        diff_url, headers=bitbucket_auth_header(username, bitbucketToken)
    )

    with urllib.request.urlopen(req, timeout=10) as resp:
        diff = resp.read().decode(errors="ignore")

    return commit_hash, diff


def download_repo_zip(destination_dir, repo_name, workspace_name, username, bitbucketToken):
    """
    Download and save a ZIP archive of a Bitbucket repository.

    Args:
        destination_dir (str): Local directory to save the zip.
        repo_name (str): Repository name.
        workspace_name (str): Bitbucket workspace.
        username (str): Username for Bitbucket auth.
        bitbucketToken (str): Token for Bitbucket auth.

    Returns:
        str: Path to the saved ZIP file.
    """
    auth = base64.b64encode(
        f"{username}:{bitbucketToken}".encode("utf-8")
    ).decode("utf-8")

    url = f"{BITBUCKET_ARCHIVE_BASE}/{workspace_name}/{repo_name}/get/{BRANCH}.zip"
    zip_path = os.path.join(destination_dir, "repo.zip")

    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {auth}",
            "Accept": "application/octet-stream"
        }
    )

    with urllib.request.urlopen(req, timeout=60) as response, open(zip_path, "wb") as f:
        f.write(response.read())

    return zip_path


def load_repo_files(root):
    """
    Read relevant files from the extracted repository tree.
    Only files matching RELEVANT_EXTENSIONS will be included.

    Args:
        root (str): Root directory of extracted repository.

    Returns:
        list: List of dictionaries with "path" and "content" keys.
    """
    files = []
    for base, _, filenames in os.walk(root):
        for name in filenames:
            path = os.path.join(base, name)
            rel_path = os.path.relpath(path, root)

            if not rel_path.endswith(RELEVANT_EXTENSIONS):
                continue

            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    files.append({"path": rel_path, "content": f.read()})
            except Exception:
                # Skip files that can't be read
                continue

    return files


def chunk_files(files):
    """
    Split repository files into chunks to fit within character limits.
    This helps manage large repositories when generating documentation.

    Args:
        files (list): List of file dictionaries.

    Returns:
        list: Nested list of chunks containing file groups.
    """
    chunks, current, size = [], [], 0

    for f in files:
        length = len(f["content"])
        if size + length > MAX_CHARS_PER_CHUNK:
            chunks.append(current)
            current, size = [], 0

        current.append(f)
        size += length

    if current:
        chunks.append(current)

    return chunks


# ------------------
# HTML / AI
# ------------------

def html_is_incomplete(html: str) -> bool:
    """
    Check whether HTML content is incomplete or structurally unbalanced.

    Args:
        html (str): HTML string to validate.

    Returns:
        bool: True if key tags are mismatched, otherwise False.
    """
    if not html:
        return True
    checks = [
        html.count("<section") != html.count("</section>"),
        html.count("<ul>") != html.count("</ul>"),
        html.count("<pre>") != html.count("</pre>"),
        html.count("<code>") != html.count("</code>")
    ]
    return any(checks)


def invoke_bedrock(prompt: str) -> str:
    """
    Invoke the Bedrock AI model with a given prompt.

    Args:
        prompt (str): Text prompt for the AI model.

    Returns:
        str: Model response text.
    """
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 8192,
        "messages": [{"role": "user", "content": prompt}]
    }

    response = bedrock.invoke_model(
        modelId=os.environ.get("BEDROCK_MODEL", "global.anthropic.claude-sonnet-4-20250514-v1:0"),
        body=json.dumps(body)
    )
    result = json.loads(response["body"].read())
    return result["content"][0]["text"]


def invoke_bedrock_with_retry(prompt: str, max_retries=3) -> str:
    """
    Retry Bedrock invocation with exponential backoff on failures.

    Args:
        prompt (str): AI prompt.
        max_retries (int): Maximum number of retries.

    Returns:
        str: Model output when successful.
    """
    for attempt in range(max_retries):
        try:
            return invoke_bedrock(prompt)
        except Exception:
            print(f"Retrying  bedrock invocation due to: {e}")
            time.sleep(((2 ** attempt) + random.uniform(0, 1))*60)
    raise RuntimeError("Max Bedrock retries reached")


def sanitize_html(html: str) -> str:
    """
    Clean up HTML generated by the AI model.

    Args:
        html (str): Raw HTML string.

    Returns:
        str: Sanitized friendly HTML.
    """
    if not html:
        raise ValueError("Empty HTML generated")

    return html.replace("&gt;&gt;", ">").replace("&lt;&lt;", "<").strip()


def generate_html_safely(diff, items, merge=False):
    """
    Generate or merge HTML documentation fragments safely.

    Args:
        diff (str): Git diff.
        items (list): File chunk list or partial HTML fragments.
        merge (bool): If True, call merge prompt builder.

    Returns:
        str: Combined HTML body.
    """
    if merge:
        prompt = build_merge_prompt(items)
    else:
        prompt = build_chunk_prompt(diff, items)

    html = invoke_bedrock_with_retry(prompt)
    attempts = 0
    while html_is_incomplete(html) and attempts < 3:
        html += invoke_bedrock_with_retry(CONTINUE_PROMPT)
        attempts += 1

    return sanitize_html(html)


# ------------------
# Prompts
# ------------------

def build_chunk_prompt(diff, files):
    """
    Build an AI prompt for chunk-level documentation generation.

    Args:
        diff (str): Git diff text.
        files (list): List of file dictionaries for one chunk.

    Returns:
        str: Prompt text for the AI model.
    """
    return f"""
You are a senior software architect.
Below is the Git diff for the latest merge:
<diff>
{diff}
</diff>
Below are source files from the repository:
<files>
{json.dumps(files)}
</files>
TASK:
Generate PARTIAL HTML documentation covering:
- Service overview
- Key components
- APIs / interfaces
- Sequence Diagrams
- Configuration
- Observability
- Deployment assumptions
RULES:
- Output ONLY valid HTML body, ensure that there are no <html>, <head>, or <head> tags. Everything should be ONLY inside the <body> tag.
- Use <h2>, <ul>, <pre>, <code>
- Dont use <section> tag
- No markdown
- For sequence diagrams, pls provide the simplemermaid image url using "https://mermaid.ink/svg/"
- Make sure in the sequence diagram if there are random string such as "&gt;&gt;" should be ">" instead
"""


def build_merge_prompt(partials):
    """
     Build a prompt to merge partial HTML into final documentation.

     Args:
         partials (list): List of partial HTML fragments.

     Returns:
         str: Prompt text to merge fragments.
     """
    return f"""
Merge the following HTML fragments into ONE complete HTML document.
Remove duplicates and ensure clean structure.
<partials>
{json.dumps(partials)}
</partials>
RULES:
- Output ONLY valid HTML inside the <body> tag.
- Make sure there is no "html" or "`" in the output
- No explanations
"""


# ------------------
# Caching (S3)
# ------------------

def get_cached_html(bucket, commit_hash):
    """
    Retrieve cached HTML for a given commit, if present in S3.

    Args:
        bucket (str): S3 bucket name.
        commit_hash (str): Commit identifier.

    Returns:
        str: Cached HTML content or None.
    """
    try:
        response_object = s3.get_object(
            Bucket=bucket,
            Key=f"{commit_hash}.html"
        )
        return response_object["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        return None


def put_cached_html(bucket, commit_hash, html):
    """
    Upload generated HTML to S3 for caching.

    Args:
        bucket (str): S3 bucket name.
        commit_hash (str): Commit identifier.
        html (str): HTML content to store.
    """
    s3.put_object(
        Bucket=bucket,
        Key=f"{commit_hash}.html",
        Body=html.encode("utf-8"),
        ContentType="text/html"
    )
