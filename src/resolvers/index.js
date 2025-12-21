import Resolver from '@forge/resolver';
import { storage } from '@forge/api';
import webhookConfig from "./webhookConfig.json";

const resolver = new Resolver();

// Define a function to store client and secret in KV
resolver.define('saveConfig', async (req) => {
  try {
    const {
      confluenceUrl,
      confluenceToken,
      bitbucketToken,
      orgAdminEmail,
      slackWebhook,
      repoId,
      workspaceId
    } = req.payload;

    console.log("Received:", req.payload);

    if (!confluenceUrl || !confluenceToken || !bitbucketToken || !orgAdminEmail) {
      return { success: false, message: "Missing required fields." };
    }

    const pageIdMatch = confluenceUrl?.match(/\/pages\/(\d+)/);
    if (!pageIdMatch) {
      console.error("Unable to extract page ID from Confluence URL");
      return { success: 400, message: "Invalid Confluence page URL" };
    }

    const prefix = `${workspaceId}_${repoId}`
    console.log("prefix:", prefix);

    // Save to KV storage
    await storage.set(prefix + 'REPO_PAGE_URL', confluenceUrl);
    await storage.set(prefix + 'REPO_BITBUCKET_TOKEN', bitbucketToken);
    await storage.set(prefix + 'REPO_CONFLUENCE_TOKEN', confluenceToken);
    await storage.set(prefix + 'REPO_ORG_ADMIN', orgAdminEmail);
    await storage.set(prefix + 'REPO_SLACK_HOOK', slackWebhook);

    const defaultEvents = webhookConfig.webhookDefaultEvents || [];

    return {
      success: true,
      message: "Configuration saved successfully!",
      webhookData: {
        webhookUrl: webhookConfig.webhookUrl,
        events: defaultEvents
      }
    };
  } catch (error) {
    console.error("Error saving config:", error);
    return { success: false, message: error.message };
  }
});

resolver.define('getConfig', async ({ context }) => {
  const workspaceId = context.workspaceId.slice(1, -1);
  const repositoryId = context.extension.repository.uuid.slice(1, -1);

  const prefix = `${workspaceId}_${repositoryId}`

  const confluenceUrl = await storage.get(prefix + 'REPO_PAGE_URL');
  const bitbucketToken = await storage.get(prefix + 'REPO_BITBUCKET_TOKEN');
  const confluenceToken = await storage.get(prefix + 'REPO_CONFLUENCE_TOKEN');
  const orgAdminEmail = await storage.get(prefix + 'REPO_ORG_ADMIN');
  const slackWebhook = await storage.get(prefix + 'REPO_SLACK_HOOK');

  return {
    success: true,
    data: {
      confluenceUrl: confluenceUrl,
      bitbucketToken: bitbucketToken,
      confluenceToken: confluenceToken,
      orgAdminEmail: orgAdminEmail,
      slackWebhook: slackWebhook
    }
  }

});

export const handler = resolver.getDefinitions();
