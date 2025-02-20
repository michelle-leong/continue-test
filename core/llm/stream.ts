import Websocket from "ws";

async function* toAsyncIterable(
  nodeReadable: NodeJS.ReadableStream,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of nodeReadable) {
    // @ts-ignore
    yield chunk as Uint8Array;
  }
}

export async function* streamResponse(
  response: Response,
): AsyncGenerator<string> {
  if (response.status !== 200) {
    throw new Error(await response.text());
  }

  if (!response.body) {
    throw new Error("No response body returned.");
  }

  // Get the major version of Node.js
  const nodeMajorVersion = parseInt(process.versions.node.split(".")[0], 10);

  if (nodeMajorVersion >= 20) {
    // Use the new API for Node 20 and above
    const stream = (ReadableStream as any).from(response.body);
    for await (const chunk of stream.pipeThrough(
      new TextDecoderStream("utf-8"),
    )) {
      yield chunk;
    }
  } else {
    // Fallback for Node versions below 20
    // Streaming with this method doesn't work as version 20+ does
    const decoder = new TextDecoder("utf-8");
    const nodeStream = response.body as unknown as NodeJS.ReadableStream;
    for await (const chunk of toAsyncIterable(nodeStream)) {
      yield decoder.decode(chunk, { stream: true });
    }
  }
}

function parseDataLine(line: string): any {
  const json = line.startsWith("data: ")
    ? line.slice("data: ".length)
    : line.slice("data:".length);

  try {
    const data = JSON.parse(json);
    if (data.error) {
      throw new Error(`Error streaming response: ${data.error}`);
    }

    return data;
  } catch (e) {
    throw new Error(`Malformed JSON sent from server: ${json}`);
  }
}

function parseSseLine(line: string): { done: boolean; data: any } {
  if (line.startsWith("data: [DONE]")) {
    return { done: true, data: undefined };
  }
  if (line.startsWith("data:")) {
    return { done: false, data: parseDataLine(line) };
  }
  if (line.startsWith(": ping")) {
    return { done: true, data: undefined };
  }
  return { done: false, data: undefined };
}

export async function* streamSse(response: Response): AsyncGenerator<any> {
  let buffer = "";
  for await (const value of streamResponse(response)) {
    buffer += value;

    let position: number;
    while ((position = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, position);
      buffer = buffer.slice(position + 1);

      const { done, data } = parseSseLine(line);
      if (done) {
        break;
      }
      if (data) {
        yield data;
      }
    }
  }

  if (buffer.length > 0) {
    const { done, data } = parseSseLine(buffer);
    if (!done && data) {
      yield data;
    }
  }
}

export async function* streamJSON(response: Response): AsyncGenerator<any> {
  let buffer = "";
  for await (const value of streamResponse(response)) {
    buffer += value;

    let position;
    while ((position = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, position);
      const data = JSON.parse(line);
      yield data;
      buffer = buffer.slice(position + 1);
    }
  }
}

export async function* streamWebSocket<T>(
  url: string,
  message: any,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const ws = new Websocket(url);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify(message));
      resolve();
    };
    ws.onerror = (err) => reject(err);
  });

  signal.addEventListener("abort", () => {
    ws.close();
  });

  let resolveMessage: (value: T | PromiseLike<T>) => void;
  let rejectMessage: (reason?: any) => void;
  let messagePromise = new Promise<T>((resolve, reject) => {
    resolveMessage = resolve;
    rejectMessage = reject;
  });

  let finished = false;
  let finalContentYielded = false;
  let aggregatedContent = "";

  ws.onmessage = (event) => {
    let dataString: string;

    if (typeof event.data === "string") {
      dataString = event.data;
    } else if (event.data instanceof ArrayBuffer) {
      dataString = new TextDecoder("utf-8").decode(event.data);
    } else {
      console.error("Unsupported data type:", typeof event.data);
      return;
    }

    const data = JSON.parse(dataString);
    if (data.agent && data.agent.eventType === "kDelta") {
      // Append to aggregated content
      aggregatedContent += data.agent.content;
      // Resolve the promise with the new content
      resolveMessage(data.agent.content as T);
      // Create a new promise for the next message
      messagePromise = new Promise<T>((resolve, reject) => {
        resolveMessage = resolve;
        rejectMessage = reject;
      });
    } else if (data.agent && data.agent.eventType === "kFinish") {
      // Check if the final content is different from the aggregated content
      if (data.agent.content !== aggregatedContent) {
        resolveMessage(data.agent.content as T);
      }
      finished = true;
      ws.close();
    }
  };

  while (!finished || !finalContentYielded) {
    try {
      const content = await messagePromise;
      yield content;
      if (finished) {
        finalContentYielded = true;
      }
    } catch (error) {
      if (signal.aborted) {
        ws.close();
        throw new Error("Aborted");
      }
      throw error;
    }
  }
}
