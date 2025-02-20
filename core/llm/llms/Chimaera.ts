import WebSocket from "ws";

import { TRIAL_FIM_MODEL } from "../../config/onboarding.js";
import {
  ChatMessage,
  Chunk,
  CompletionOptions,
  LLMOptions,
} from "../../index.js";
import { BaseLLM } from "../index.js";
import { streamWebSocket } from "../stream.js";

class Chimaera extends BaseLLM {
  static providerName = "chimaera";
  static defaultOptions: Partial<LLMOptions> | undefined = {
    maxEmbeddingBatchSize: 128,
    model: "voyage-code-2",
  };

  constructor(options: LLMOptions) {
    super(options);
    this.embeddingId = `${this.constructor.name}::${this.model}`;
  }

  private async *_wsStream<T>(
    action: string,
    payload: any,
    signal: AbortSignal,
  ): AsyncGenerator<T> {
    let combinedMessages: string = "";
    if (Array.isArray(payload.messages)) {
      combinedMessages = payload.messages
        .map((message) => {
          if (typeof message.content === "string") return message.content;
          else return message.content.map((part) => part.text).join("");
        })
        .flat()
        .join("\n");
    }

    const formattedMessage = { user: { content: combinedMessages } };

    for await (const content of streamWebSocket<T>(
      "ws://localhost:8765",
      formattedMessage,
      signal,
    )) {
      console.log("in ws stream", content);
      yield content;
    }
  }

  private _wsRequest<T>(
    action: string,
    payload: any,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = new WebSocket("ws://localhost:8765");

      ws.onopen = () => {
        ws.send(JSON.stringify({ action, ...payload }));
      };

      ws.onerror = (err) => {
        reject(err);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        ws.close();
        resolve(data);
      };

      if (signal) {
        signal.addEventListener("abort", () => {
          ws.close();
          reject(new Error("Aborted"));
        });
      }
    });
  }

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const chunk of this._wsStream<string>(
      "stream_complete",
      { prompt },
      signal,
    )) {
      console.log("in stream complete", chunk);
      yield chunk;
    }
  }

  protected _convertMessage(message: ChatMessage) {
    console.log("message", message);
    if (!message.agent || !message.agent.content) {
      return message; // Return the message as is if agent or content is undefined
    }

    const content = message.agent.content;
    if (typeof content === "string") {
      return content;
    }

    const parts = content.map((part) => {
      if (part.type === "imageUrl") {
        return {
          type: "image_url",
          image_url: {
            url: part.imageUrl.url,
            detail: "low",
          },
        };
      }
      return {
        type: "text",
        text: part.text,
      };
    });
    return {
      ...message,
      content: parts,
    };
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    const convertedMessages = messages.map(this._convertMessage);
    console.log("Converted Messages:", convertedMessages);

    for await (const chunk of this._wsStream<string>(
      "stream_chat",
      { messages: convertedMessages },
      signal,
    )) {
      if (chunk.trim()) {
        const chatMessage = { role: "assistant", content: chunk };
        console.log("Yielding Chat Message:", chatMessage);
        yield chatMessage;
      }
    }
  }

  protected async _embed(chunks: string[]): Promise<number[][]> {
    const resp = await this.fetch("http://127.0.0.1:1234", {
      method: "POST",
      body: JSON.stringify({
        input: chunks,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (resp.status !== 200) {
      throw new Error(`Failed to embed: ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    return data.embeddings;
  }

  async rerank(query: string, chunks: Chunk[]): Promise<number[]> {
    if (chunks.length === 0) {
      return [];
    }
    const response = await this._wsRequest<{ results: any[] }>("rerank", {
      query,
      documents: chunks.map((chunk) => chunk.content),
    });
    return response.results.map((result: any) => result.relevance_score);
  }

  async listModels(): Promise<string[]> {
    return [
      "codestral-latest",
      "claude-3-5-sonnet-latest",
      "llama3.1-405b",
      "llama3.1-70b",
      "gpt-4o",
      "gpt-3.5-turbo",
      "claude-3-5-haiku-latest",
      "gemini-1.5-pro-latest",
    ];
  }
}

export default Chimaera;
