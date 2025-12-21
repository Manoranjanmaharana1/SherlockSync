import * as api from "@forge/api";
import {storage} from "@forge/api";
import { Queue } from '@forge/events';
import * as cheerio from "cheerio";
import { AsyncEvent } from '@forge/events';

const API_KEY = 'LPKQobhYZx17o7bBubwCH9OCBAOOjlfN68irEya1';

// only retry on these status codes
const RETRY_STATUS = [408, 429, 500, 502, 503, 504];


/**
 * Converts all <img> in the provided fragment
 * into Confluence <ac:image><ri:url> markup and
 * returns a clean HTML fragment string.
 */
function convertImgsToConfluence(htmlFragment) {
  const $ = cheerio.load(htmlFragment, {
    xmlMode: false,   // treat as HTML, not XML
    decodeEntities: false // preserve special characters
  }, false);

  $("img").each((_, img) => {
    const src = $(img).attr("src") || "";
    const alt = $(img).attr("alt") || "";

    // Build Confluence storage format image
    const acImage = `
      <ac:image ac:align="center" ac:width="100%" ac:alt="${alt.replace(/"/g, "&quot;")}">
        <ri:url ri:value="${src.replace(/"/g, "&quot;")}" />
      </ac:image>
    `;

    // Replace the <img> tag with the Confluence version
    $(img).replaceWith(acImage);
  });

  // Return just the inner HTML (clean fragment string)
  return $.root().html();
}


/**
 * Send a message to a Slack channel via Incoming Webhook
 * @param {string} webhookUrl - Your Slack webhook URL (keep it secret!)
 * @param {string} message - The text message you want to post
 * @returns {Promise<void>}
 */
async function sendSlackWebhookMessage(webhookUrl, message) {
  if (!webhookUrl) {
    throw new Error("Slack webhook URL is required");
  }
  if (!message) {
    throw new Error("Message text is required");
  }

  // Compose the minimal payload — Slack expects at least “text”
  const payload = {
    text: message
  };

  try {
    // Send POST request to Slack webhook
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Slack webhook error (${response.status}): ${errorText}`);
    }
  } catch (err) {
    console.error("Failed to send Slack webhook message:", err);
    throw err;
  }
}

/**
 * Fetch Confluence page content by URL
 * @param {string} confluenceUrl - The Confluence page URL stored in storage
 * @param {string} email - Atlassian account email
 * @param {string} token - API Token for Confluence
 * @returns {Promise<Object>} page content JSON
 */
async function fetchConfluencePage(confluenceUrl, email, token) {
  // extract page ID
  const idMatch = confluenceUrl?.match(/\/pages\/(\d+)/);
  if (!idMatch) {
    throw new Error("Unable to extract Confluence page ID from URL");
  }
  const pageId = idMatch[1];

  // build full API URL
  const fullUrl = `${new URL(confluenceUrl).origin}/wiki/rest/api/content/${pageId}?expand=body.storage,version`;

  // encode Basic Auth
  const basicAuth = Buffer.from(`${email}:${token}`).toString("base64");

  // call Confluence API
  const response = await api.fetch(fullUrl, {
    method: "GET",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Confluence API error (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Simple retry on HTTP errors (no timeout)
 * @param {string} url
 * @param {object} options
 * @param {number} retries
 * @param {number} retryDelayInMs
 */
async function fetchWithRetry(url, options, retries = 3, retryDelayInMs = 60000) {

  for (let i = 0; i < retries; i++) {
      const response = await api.fetch(url, options);

      if (response.ok) {
        return response;
      }

      // Retry only on 5xx gateway/timeouts
      if (!RETRY_STATUS.includes(response.status)) {
        // non-retryable — throw immediately
        throw new Error(`HTTP ${response.status} ${response.statusText}`);;
      }

      console.warn(`Retry ${i + 1} failed with status ${response.status}, retrying...`);

      // small delay before next attempt
      await new Promise(res => setTimeout(res, retryDelayInMs));
  }
}

/**
 * Update a Confluence page
 * @param {string} confluenceUrl - The Confluence page URL stored in storage
 * @param {string} newHtml - HTML content you want on the page
 * @param {string} email - Atlassian account email
 * @param {string} newTitle - Title of the page
 * @param {string} apiToken - Atlassian API token
 * @param {number} curVersion - Current version
 */
async function updateConfluencePage(confluenceUrl, newHtml, newTitle, email, apiToken, curVersion) {
  const idMatch = confluenceUrl?.match(/\/pages\/(\d+)/);
  if (!idMatch) {
    throw new Error("Unable to extract Confluence page ID from URL");
  }
  console.log("HTML Content: ", newHtml);
  const pageId = idMatch[1];

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

  const currentVersion = curVersion || 1;

  const putBody = {
    id: pageId,
    type: "page",
    title: newTitle,
    body: {
      storage: {
        value: newHtml,
        representation: "storage",
      },
    },
    metadata: {
      properties: {
        editor: {
          key: "editor",
          value: "v2"
        }
      }
    },
    version: {
      number: currentVersion + 1, // MUST increment!
    },
  };

  const putRes = await fetch(
      `${new URL(confluenceUrl).origin}/wiki/rest/api/content/${pageId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(putBody),
      }
  );

  if (!putRes.ok) {
    const errorText = await putRes.text();
    throw new Error(`Update failed ${putRes.status}: ${errorText}`);
  }

  const updated = await putRes.json();
  console.log("Updated page successfully:", updated);
  return updated;
}


/**
 * Generate Confluence page content using current Repo and Confluence data
 * @param {string} htmlContent - The Confluence page content in HTML
 * @param {string} repoName - Repo Name
 * @param {string} workspaceName - Workspace Name
 * @param {string} bitbucketToken - API Token for BitBucket
 * @param {string} orgAdminEmail - Org Admin Email
 * @returns {Promise<Object>} page content in HTML
 */
async function generateDocPage(htmlContent, repoName, workspaceName, bitbucketToken, orgAdminEmail) {

  console.log("Generating page content")

  const postData = {
    htmlContent: htmlContent,
    repoName: repoName,
    workspaceName: workspaceName,
    bitbucketToken: bitbucketToken,
    orgAdminEmail: orgAdminEmail
  };

  // call Confluence API with Retry
  const response = await fetchWithRetry(
      'https://xlaspv6o66.execute-api.us-east-1.amazonaws.com/default',
      {
        method: "POST",
        headers: {
          "X-API-Key": API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ body: postData })
      },
      3 // try up to 3 times
  );
  console.log("Response: ", response);

  return await response.json();

}

/**
 * @param {import('@forge/api').WebTriggerRequest} event
 * @param {import('@forge/api').WebTriggerContext} context
 */
export async function runSync(event, context) {
  let payload;
  try {
    payload = JSON.parse(event.body);
    console.log(payload);
  } catch (err) {
    console.error("Invalid JSON", err);
    return { statusCode: 400, body: "Bad Request" };
  }

  const repoId = payload.repository?.uuid?.slice(1, -1);
  const workspaceId = context.workspaceId.slice(1, -1);
  const prefix = `${workspaceId}_${repoId}`;

  const repoName = payload.repository.name
  const workspaceName = payload.repository.workspace.name;

  console.log("prefix: ", prefix);

  const confluenceUrl = await storage.get(prefix + 'REPO_PAGE_URL');
  const bitbucketToken = await storage.get(prefix + 'REPO_BITBUCKET_TOKEN');
  const confluenceToken = await storage.get(prefix + 'REPO_CONFLUENCE_TOKEN');
  const orgAdminEmail = await storage.get(prefix + 'REPO_ORG_ADMIN');
  const slackWebhook = await storage.get(prefix + 'REPO_SLACK_HOOK');

  console.log("confluenceUrl: ", confluenceUrl);
  console.log("bitbucketToken: ", bitbucketToken);
  console.log("confluenceToken: ", confluenceToken);
  console.log("orgAdminEmail: ", orgAdminEmail);
  console.log("slackWebhook: ", slackWebhook);

  try {

    const pageData = await fetchConfluencePage(
        confluenceUrl,
        orgAdminEmail,
        confluenceToken
    );

    console.log("Fetched Confluence page data: ", pageData);

    // extract the HTML storage/body (if you want to use it later):
    const htmlContent = pageData.body?.storage?.value;

    const queue = new Queue({ key: 'doc-generation-queue' });
    const eventBody = {
      repoName: repoName,
      workspaceName: workspaceName,
      bitbucketToken: bitbucketToken,
      orgAdminEmail: orgAdminEmail,
      docVersion: pageData.version?.number,
      docTitle: pageData.title,
      pageContent: htmlContent,
      confluenceToken: confluenceToken,
      confluenceUrl: confluenceUrl,
      slackWebhook: slackWebhook
    };

    const { jobId } = await queue.push({ body: eventBody });

    return {
      statusCode: 200,
      job: jobId

    };
  } catch (err) {
    console.error("Error:", err);
    return {
      statusCode: 500,
      body: `Error: ${err.message}`,
    };
  }
}

export async function process(event, context) {

  let body;
  try {
    console.log("Received event: ", event)
    body = event.body;
  } catch (err) {
    console.error("Invalid JSON", err);
    return {
      statusCode: 400,
      body: "Bad Request"
    };
  }

  const repoName = body.repoName;
  const workspaceName = body.workspaceName;
  const bitbucketToken = body.bitbucketToken;
  const orgAdminEmail = body.orgAdminEmail;
  const docVersion = body.docVersion;
  const docTitle = body.docTitle;
  const pageContent = body.pageContent;
  const confluenceToken = body.confluenceToken;
  const confluenceUrl = body.confluenceUrl;
  const slackWebhook = body.slackWebhook;

  try {

    const generatedDoc = await generateDocPage(
        pageContent,
        repoName,
        workspaceName,
        bitbucketToken,
        orgAdminEmail
    );
    console.log(generatedDoc);
    const updatedHtml = convertImgsToConfluence(generatedDoc.newHtmlContent);
    console.log("Updated html: ", updatedHtml);
    const updatedDoc = await updateConfluencePage(confluenceUrl,
        updatedHtml,
        docTitle,
        orgAdminEmail,
        confluenceToken,
        docVersion
    );
    const baseUrl = updatedDoc?._links?.base;
    const tinyUrl = `${baseUrl}${tinyui}`;
    const messageText = `Hi! Document ${pageData.title} has been updated. You can review the Document here - ${tinyUrl}`;
    await sendSlackWebhookMessage(slackWebhook, messageText)

  } catch (err) {
    console.error("Error:", err);
    const messageText = `Hi! There was a failure while updating the Document ${pageData.title}. Failure reason - ${err}`;
    await sendSlackWebhookMessage(slackWebhook, messageText)
  }
}
