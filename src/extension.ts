"use strict";

import * as vscode from "vscode";
import OpenAI from "openai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as https from "https";
import sharp from "sharp";
import { GitExtension } from "./git";
import { getProgressMessage } from "./promptUtils";
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");

const LANGUAGE_MODEL_FAMILY = "gpt-4";

export function activate(extContext: vscode.ExtensionContext) {
  const agent = vscode.chat.createChatParticipant(
    "dalle.chat",
    async (request, context, response, token) => {
      let imageGenPrompt =
        request.prompt ||
        "A photo of a bicyclist in Seattle carrying a laptop and writing code while simultaneously riding a bike.";

      const reg =
        /(^|\s)\[(#)([\w_\-]+)(:[\w_\-\.]+)?\]\(values:([\w_\-]+)(:[\w_\-\.]+)?\)/gi;
      imageGenPrompt = imageGenPrompt.replace(reg, "");
      const models = await vscode.lm.selectChatModels({
        family: LANGUAGE_MODEL_FAMILY,
      })!;
      let promptRequest;
      if (models.length > 0) {
        response.progress(getProgressMessage());
        const [first] = models;
        promptRequest = await first.sendRequest(
          [
            new vscode.LanguageModelChatMessage(
              vscode.LanguageModelChatMessageRole.Assistant,
              "You write creative prompts for an AI image generator. The user will give a short phrase, and you must generate a prompt for DALL-E based on that phrase. Don't forget to include the art style for the image. For example, it could be an oil painting, a photograph, a cartoon, a charcoal drawing, or something else. Reply with the prompt and no other text."
            ),
            new vscode.LanguageModelChatMessage(
              vscode.LanguageModelChatMessageRole.User,
              imageGenPrompt
            ),
          ],
          {},
          token
        );
      } else {
        console.log("No models available");
        return;
      }

      let prompt = "";
      for await (const chunk of promptRequest.text) {
        prompt += chunk;
      }

      imageGenPrompt = prompt;

      const { smallFilePath, resultUrl } = await getAiImage(
        extContext,
        imageGenPrompt
      );
      const imageContent = `![image](file://${smallFilePath})`;
      response.markdown(imageContent);
      response.markdown(`\n`);
      const fullSizeLink = `[Full size](${resultUrl})  `;
      response.markdown(fullSizeLink);
      response.markdown(`\n`);
      const lastComment = `Have a great day!`;
      response.markdown(lastComment);

      agent.iconPath = vscode.Uri.file(
        path.join(`${extContext.extensionPath}/images`, "dall-e.png")
      );

      extContext.subscriptions.push(agent);
    }
  );
}

export function deactivate() {}

async function getAiImage(
  extContext: vscode.ExtensionContext,
  imageGenPrompt: string
): Promise<{ smallFilePath: string; resultUrl: string }> {
  const azureEndpoint = getAzureEndpoint();
  const key = azureEndpoint
    ? await getAzureOpenAIKey(extContext)
    : await getOpenAIKey(extContext);
  if (!key) {
    throw new Error("Missing OpenAI API key");
  }

  const openai = azureEndpoint
    ? new OpenAIClient(azureEndpoint, new AzureKeyCredential(key))
    : new OpenAI({ apiKey: key });
  let resultUrl = "";
  if (azureEndpoint && openai instanceof OpenAIClient) {
    const imageResponse = await openai.getImages(
      getAzureDeploymentName(),
      imageGenPrompt,
      {
        n: 1,
        size: "1024x1024",
      }
    );
    resultUrl = (imageResponse.data[0] as any).url!;
  } else if (openai instanceof OpenAI) {
    const imageGen = await openai.images.generate({
      prompt: imageGenPrompt,
      model: "dall-e-3",
      n: 1,
      size: "1024x1024",
      quality: "hd",
    });
    resultUrl = imageGen.data[0].url!;
  }

  console.log(resultUrl);

  const randomFileName = crypto.randomBytes(20).toString("hex");
  const tempFileWithoutExtension = path.join(
    os.tmpdir(),
    "chat-agent-dalle",
    `${randomFileName}`
  );
  const tmpFilePath = tempFileWithoutExtension + ".png";
  console.log(tmpFilePath);

  await downloadFile(resultUrl!, tmpFilePath);

  const smallFilePath = tempFileWithoutExtension + "-small.png";
  const inputBuffer = await fs.promises.readFile(tmpFilePath);
  await sharp(inputBuffer).resize({ width: 400 }).toFile(smallFilePath);

  return { smallFilePath, resultUrl };
}

function getAzureEndpoint() {
  return vscode.workspace
    .getConfiguration("dalle.chat")
    .get<string>("azureEndpoint");
}

function getAzureDeploymentName() {
  return vscode.workspace
    .getConfiguration("dalle.chat")
    .get<string>("deploymentName");
}

function getAzureApiKey() {
  return vscode.workspace
    .getConfiguration("dalle.chat")
    .get<string>("apiToken");
}

const openAIKeyName = "openai.aiKey";
const azureOpenAIKeyName = "azure.openai.aiKey";
async function getAzureOpenAIKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const storedKey =
    (await context.secrets.get(azureOpenAIKeyName)) || getAzureApiKey();
  if (storedKey) {
    return storedKey;
  } else {
    const newKey = await vscode.window.showInputBox({
      placeHolder: "Enter your Azure OpenAI API key",
      prompt: "This can be found in your Azure portal",
    });
    if (newKey) {
      context.secrets.store(openAIKeyName, newKey);
      return newKey;
    } else {
      return;
    }
  }
}

async function getOpenAIKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const storedKey = await context.secrets.get(openAIKeyName);
  if (storedKey) {
    return storedKey;
  } else {
    const newKey = await vscode.window.showInputBox({
      placeHolder: "Enter your OpenAI API key",
      prompt:
        "You can create an API key [here](https://platform.openai.com/api-keys)",
    });
    if (newKey) {
      context.secrets.store(openAIKeyName, newKey);
      return newKey;
    } else {
      return;
    }
  }
}

async function downloadFile(
  url: string,
  destPath: string,
  headers?: Record<string, string>
): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (response) => {
        if (response.headers.location) {
          console.log(`Following redirect to ${response.headers.location}`);
          return downloadFile(response.headers.location, destPath).then(
            resolve,
            reject
          );
        }

        if (response.statusCode === 404) {
          return reject(new Error(`File not found: ${url}`));
        }

        const file = fs.createWriteStream(destPath);
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          file.close();
          reject(err);
        });
      })
      .on("error", (err) => {
        fs.unlink(destPath, () => reject(err));
      });
  });
}
