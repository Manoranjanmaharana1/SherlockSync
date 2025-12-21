import React, {useEffect, useState} from "react";
import ForgeReconciler, {
    Box,
    Text,
    Form,
    FormHeader,
    FormSection,
    FormFooter,
    Label,
    RequiredAsterisk,
    Textfield,
    LoadingButton,
    Inline,
    Spinner,
    SectionMessage,
    ErrorMessage,
    Link,
    ListItem,
    List,
    Stack
} from "@forge/react";
import {invoke, view} from "@forge/bridge";

const SetupForm = () => {
    const [submitting, setSubmitting] = useState(false);
    const [isSubmitDisabled, setIsSubmitDisabled] = useState(false);
    const [generalError, setGeneralError] = useState("");
    const [successMessage, setSuccessMessage] = useState("");
    const [webhookUrl, setWebhookUrl] = useState("");
    const [webhookEvents, setWebhookEvents] = useState([]);
    const [formValues, setFormValues] = useState({
        confluenceUrl: "",
        confluenceToken: "",
        bitbucketToken: "",
        orgAdminEmail: "",
        slackWebhook: ""
    });
    const [fieldErrors, setFieldErrors] = useState({});

    const handleChange = (field) => (value) => {
        setIsSubmitDisabled(false);
        setFormValues((values) => ({ ...values, [field]: value.target.value }));
    };

    useEffect(() => {
        const fetchValues = async () => {
            const response = await invoke("getConfig");
            // console.log(response);
            if (response.success) {
                setFormValues({
                    confluenceUrl: response.data.confluenceUrl || "",
                    bitbucketToken: response.data.bitbucketToken || "",
                    confluenceToken: response.data.confluenceToken || "",
                    orgAdminEmail: response.data.orgAdminEmail || "",
                    slackWebhook: response.data.slackWebhook || "",
                });
                if (response.data.confluenceUrl
                    || response.data.bitbucketToken
                    || response.data.confluenceToken
                    || response.data.orgAdminEmail) {
                    setIsSubmitDisabled(true);
                }
            }
        };
        fetchValues();
    }, []);

    const validateForm = () => {
        const errors = {};

        if (!formValues.confluenceUrl.trim()) {
            errors.confluenceUrl = "Confluence PageId is required";
        }
        if (!formValues.bitbucketToken.trim()) {
            errors.bitbucketToken = "Bitbucket Token is required";
        }
        if (!formValues.confluenceToken.trim()) {
            errors.confluenceToken = "Confluence Token is required";
        }
        if (!formValues.orgAdminEmail.trim()) {
            errors.orgAdminEmail = "Org Admin email is required";
        }

        setFieldErrors(errors);
        return Object.keys(errors).length === 0;
    };

    const handleSubmit = async () => {
        setGeneralError("");
        setSuccessMessage("");

        if (!validateForm()) {
            return;
        }

        setSubmitting(true);

        const context = await view.getContext();
        formValues['repoId'] = context.extension.repository.uuid.slice(1, -1);
        formValues['workspaceId'] = context.workspaceId.slice(1, -1);
        try {
            const saveRes = await invoke("saveConfig", formValues);
            if (!saveRes.success) {
                setGeneralError("Error saving config: " + saveRes.message);
                setSubmitting(false);
                return;
            }

            setSuccessMessage("🎉 Setup complete!");
            setWebhookUrl(saveRes.webhookData.webhookUrl);
            setWebhookEvents(saveRes.webhookData.events);

        } catch (err) {
            setGeneralError("Unexpected error: " + err.message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Form onSubmit={handleSubmit}>
            {/* Info Message */}
            <Box padding="space.200">
                <SectionMessage appearance="information">
                    <Text>
                        This setup requires creating an API Token.{" "}
                        <Link
                            href="https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token"
                            openNewTab
                        >
                            Follow this guide to create an API Token
                        </Link>
                        . When configuring the token for Bitbucket, be sure to include the following scopes –{" "}
                        <Text as="span" weight="bold">read:repository:bitbucket</Text>,{" "}
                        <Text as="span" weight="bold">read:package:bitbucket</Text>. Create normal API Token for Confluence.
                        To create API Tokens in your Atlassian account, see{" "}
                        <Link
                            href="https://id.atlassian.com/manage-profile/security/api-tokens"
                            openNewTab
                        >
                            API Token management console
                        </Link>
                        .
                    </Text>
                </SectionMessage>
            </Box>



            <FormHeader>
                Seamlessly integrates your repository with Confluence to automatically keep documentation up to date — no manual effort required.
            </FormHeader>

            <FormSection>
                <Stack space="space.300">
                    <Box>
                        <Label labelFor="confluenceUrl">
                            Confluence Page URL <RequiredAsterisk />
                        </Label>
                        <Textfield
                            id="confluenceUrl"
                            value={formValues.confluenceUrl}
                            onChange={handleChange("confluenceUrl")}
                        />
                        {fieldErrors.confluenceUrl && (
                            <ErrorMessage>{fieldErrors.confluenceUrl}</ErrorMessage>
                        )}
                    </Box>

                    <Box>
                        <Label labelFor="confluenceToken">
                            Confluence Token <RequiredAsterisk />
                        </Label>
                        <Textfield
                            id="confluenceToken"
                            value={formValues.confluenceToken}
                            type="password"
                            onChange={handleChange("confluenceToken")}
                        />
                        {fieldErrors.confluenceToken && (
                            <ErrorMessage>{fieldErrors.confluenceToken}</ErrorMessage>
                        )}
                    </Box>

                    <Box>
                        <Label labelFor="bitbucketToken">
                            Bitbucket Token <RequiredAsterisk />
                        </Label>
                        <Textfield
                            id="bitbucketClient"
                            value={formValues.bitbucketToken}
                            type="password"
                            onChange={handleChange("bitbucketToken")}
                        />
                        {fieldErrors.bitbucketToken && (
                            <ErrorMessage>{fieldErrors.bitbucketToken}</ErrorMessage>
                        )}
                    </Box>

                    <Box>
                        <Label labelFor="orgAdminEmail">
                            Org Admin Email <RequiredAsterisk />
                        </Label>
                        <Textfield
                            id="orgAdminEmail"
                            value={formValues.orgAdminEmail}
                            type="password"
                            onChange={handleChange("orgAdminEmail")}
                        />
                        {fieldErrors.orgAdminEmail && (
                            <ErrorMessage>{fieldErrors.orgAdminEmail}</ErrorMessage>
                        )}
                    </Box>

                    <Box>
                        <Label labelFor="slackWebhook">
                            Slack channel Webhook (Optional)
                        </Label>
                        <Textfield
                            id="slackWebhook"
                            value={formValues.slackWebhook}
                            onChange={handleChange("slackWebhook")}
                        />
                        {fieldErrors.slackWebhook && (
                            <ErrorMessage>{fieldErrors.slackWebhook}</ErrorMessage>
                        )}
                    </Box>
                </Stack>
            </FormSection>

            {/* Submit */}
            <FormFooter align="start">
                <Inline space="space.200">
                    <LoadingButton
                        appearance="primary"
                        type="submit"
                        isLoading={submitting}
                        isDisabled={isSubmitDisabled}
                    >
                        {submitting ? <Spinner label="Please wait…" /> : "Save & Configure"}
                    </LoadingButton>
                </Inline>
            </FormFooter>

            {/* Spacer */}
            <Box padding="space.200" />

            {/* Error */}
            {generalError && (
                <Box padding="space.200">
                    <SectionMessage appearance="error">
                        <Text>{generalError}</Text>
                    </SectionMessage>
                </Box>
            )}

            {/* Success */}
            {successMessage && (
                <Box padding="space.200">
                    <SectionMessage title={successMessage} appearance="success">
                        <Stack space="space.200">
                            <Box>
                                <Text>
                                    Configure the webhook URL in your Bitbucket repo to start updating the document:
                                </Text>
                            </Box>

                            <Box>
                                <Text weight="bold">Webhook URL:</Text>
                                <Text>{webhookUrl}</Text>
                            </Box>

                            <Box>
                                <Text weight="bold">Subscribed Events:</Text>
                                <List type="unordered">
                                    {webhookEvents.map((event, index) => (
                                        <ListItem key={index}>
                                            <Text>{event}</Text>
                                        </ListItem>
                                    ))}
                                </List>
                            </Box>

                            <Box>
                                <Text>
                                    More info:{" "}
                                    <Link
                                        href="https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/"
                                        openNewTab
                                    >
                                        Manage webhooks documentation
                                    </Link>
                                </Text>
                            </Box>
                        </Stack>
                    </SectionMessage>
                </Box>
            )}
        </Form>
    );
};

ForgeReconciler.render(
    <React.StrictMode>
        <Box padding="medium">
            <SetupForm />
        </Box>
    </React.StrictMode>
);
