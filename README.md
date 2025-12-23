# 📘 Project SherlockSync
![](https://d112y698adiu2z.cloudfront.net/photos/production/software_photos/004/110/134/datas/original.png)

This repository contains:

1. **Forge App for Bitbucket** – adds custom UI on Bitbucket Repository Settings Menu Page.
2. **AWS Lambda Function (Python)** – contains the business logic which interacts with AI Model.

## 📁 Repository Structure

```
/
├── SherlockSync/
│   ├── manifest.yml
│   ├── README.md
│   ├── src/
│   │   ├── backend/
│   │   │   └── lambda/
│   │   ├── frontend/
│   │   ├── resolver/
│   │   ├── trigger/
│   │   └── index.js
│   └── package.json
```

## 🌐 SherlockSync Lambda Development

This contains the core logic to analyze the Confluence and BitBucket metadata, to generate new Confluence data, by utilising the AWS Bedrock. 

See [AWS Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html) for more info on how to build on AWS Bedrock.

### Requirements

* New AWS Account - [Follow this](https://portal.aws.amazon.com/gp/aws/developer/registration/index.html?nc2=h_su&src=header_signup&refid=ca86b8bb-1768-461a-8957-fb245be65275)

### Setup resources for the AWS Lambda

#### Setup AWS S3 Bucket
* Follow this - [creating S3 bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html) and note the name.

#### Setup AWS Lambda Function
##### Create a deployable ZIP

```bash
cd src/backend/lambda/auto_doc_generator
mkdir package
pip3 install -r requirements.txt -t package
cd package
zip -r ../function.zip .
cd ../
zip -g function.zip handler.py utils.py
```

(You can automate via `build.sh` too.)

##### Deploying the AWS Lambda
* [Follow this](https://docs.aws.amazon.com/lambda/latest/dg/configuration-function-zip.html) to deploy your `.zip` folder
* Runtime settings -
  * Runtime - Python 3.14
  * HandlerInfo - handler.lambda_handler
  * ArchitectureInfo - arm64/x86_64 (any would work)
* Setup Env variable
  * `archive_s3_bucket` with the s3 bucket you just created.

##### Testing AWS Lambda
Sample test event - 
```json
{
  "body": {
    "htmlContent": "",
    "repoName": "Excerpts",
    "workspaceName": "copycat2025",
    "bitbucketToken": "dummy-bitbucket-token",
    "orgAdminEmail": "person@gmail.com"
  }
}
```

#### Setup AWS API Gateway
* [Create a new REST API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/getting-started-rest-new-console.html?utm_source=chatgpt.com#getting-started-rest-new-console-create-api) to quickly setup a REST API Gateway. Don't forget to [deploy](https://docs.aws.amazon.com/apigateway/latest/developerguide/getting-started-rest-new-console.html?utm_source=chatgpt.com#getting-started-rest-new-console-deploy) your new API Gateway
* [Attach newly created AWS Lambda Function to the REST API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/getting-started-rest-new-console.html?utm_source=chatgpt.com#getting-started-rest-new-console-create-integration)
* Create an API Key -
  * In API Gateway Console → API Keys
  * Click Create API Key
  * Give a name and optionally a value
  * Save the key
* Create a Usage Plan - [detailed steps](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-create-usage-plans.html)
  * Go to Usage Plans
  * Click Create Usage Plan
  * Enter a name, throttle & quota settings
  * Under Associated API Stages, attach your deployed API and stage
  * Save
* Associate API Key With Usage Plan
  * Under the usage plan, API Keys → Add API Key to Usage Plan
  * Select your previously created API Key
  * Save
* Attach the API Key - [follow this](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-setup-api-keys.html)
* Get the API Gateway url - [follow this](https://docs.aws.amazon.com/apigateway/latest/developerguide/getting-started-rest-new-console.html?utm_source=chatgpt.com#getting-started-rest-new-console-invoke-api)
* Update the API Gateway url and API Key in the code - `src/trigger/index.jsx`

## 📦 SherlockSync Forge App Development

This project contains a Forge app written in Javascript that displays a UI Form in a Bitbucket Repository Settings Menu Page.

See [developer.atlassian.com/platform/forge/](https://developer.atlassian.com/platform/forge) for documentation and tutorials explaining Forge.

### Requirements

See [Set up Forge](https://developer.atlassian.com/platform/forge/set-up-forge/) for instructions to get set up.

### Quick start

- Modify your app frontend by editing the `src/frontend/index.jsx` file.

- Modify your app backend by editing the `src/resolvers/index.js` file to define resolver functions. See [Forge resolvers](https://developer.atlassian.com/platform/forge/runtime-reference/custom-ui-resolver/) for documentation on resolver functions.

- Modify the web trigger by editing the `src/trigger/index.js` file to define what actions to perform on Bitbucket events.

- Build and deploy your app by running:
```
forge deploy
```

- Install your app in a Bitbucket workspace by running:
```
forge install
```

- Develop your app by running `forge tunnel` to proxy invocations locally:
```
forge tunnel
```

#### Notes
- Use the `forge deploy` command when you want to persist code changes.
- Use the `forge install` command when you want to install the app on a new workspace.
- Once the app is installed on a workspace, the workspace picks up the new app changes you deploy without needing to rerun the install command.

### 💡 Debugging

#### Lambda Logs

Logs are available in CloudWatch:

```bash
aws logs tail /aws/lambda/YOUR_LAMBDA_NAME --follow
```

#### Forge App Logs

While running:

```bash
forge logs --verbose
```

## 📜 License

Distributed under the MIT License.
