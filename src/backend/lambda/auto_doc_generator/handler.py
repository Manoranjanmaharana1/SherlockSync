import os
import json

from utils import (
    fetch_diff,
    download_repo_zip,
    load_repo_files,
    chunk_files,
    generate_html_safely,
    get_cached_html,
    put_cached_html
)

def lambda_handler(event, context):
    """
    AWS Lambda entrypoint that:
    - computes diff and commit hash
    - loads repo files
    - chunks and asks AI to generate partial docs
    - merges into final HTML
    - returns HTML + caching
    """

    print("Received event:", json.dumps(event))

    body = event.get("body") or {}
    diff_data = body.get("htmlContent")
    repo_name = body["repoName"]
    workspace_name = body["workspaceName"]
    username = body["orgAdminEmail"]
    bitbucketToken = body["bitbucketToken"]
    bucket = os.environ["archive_s3_bucket"]

    # Fetch latest commit_hash & the diff between top two commits
    commit_hash, diff = fetch_diff(
        repo_name, workspace_name, username, bitbucketToken
    )

    print(f"Commit hash: {commit_hash}")

    # Check Cache
    cached_html = get_cached_html(bucket, commit_hash)
    if cached_html:
        print(f"Cache hit — returning cached HTML")
        return {
            "statusCode": 200,
            "newHtmlContent": cached_html,
            "newTitle": "Cached Documentation",
            "cached": True
        }

    # Pull repo & load files
    with tempfile.TemporaryDirectory() as tmp:
        zip_path = download_repo_zip(
            tmp, repo_name, workspace_name, username, bitbucketToken
        )

        with zipfile.ZipFile(zip_path, "r") as z:
            z.extractall(tmp)

        files = load_repo_files(tmp)

    # Chunk and generate partial docs
    chunks = chunk_files(files)
    partial_docs = [
        generate_html_safely(diff, chunk) for chunk in chunks
    ]

    # Merge all fragments
    final_html = generate_html_safely(diff, partial_docs, merge=True)

    # Persist into cache
    put_cached_html(bucket, commit_hash, final_html)

    return {
        "statusCode": 200,
        "newHtmlContent": final_html,
        "newTitle": "Generated Documentation",
        "cached": False
    }
