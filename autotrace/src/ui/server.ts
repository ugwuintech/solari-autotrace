import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InvestigationFormInput, InvestigationUiError } from "../types/ui.js";
import {
  InvestigationInputError,
  investigateFromUiInput,
} from "./investigateFromUiInput.js";

const DEFAULT_PORT = 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Read a JSON request body with a modest size ceiling so the tester cannot flood the process.
async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const maxBytes = 64_000;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new InvestigationInputError("Request body is too large.");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    throw new InvestigationInputError("Request body is required.");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InvestigationInputError("Request body must be valid JSON.");
  }
}

// Narrow the JSON body into the form fields the investigation entry expects.
function asFormInput(body: unknown): InvestigationFormInput {
  if (typeof body !== "object" || body === null) {
    throw new InvestigationInputError("Request body must be a JSON object.");
  }

  const record = body as Record<string, unknown>;
  return {
    vehicle: typeof record.vehicle === "string" ? record.vehicle : "",
    codes: typeof record.codes === "string" ? record.codes : "",
    symptoms: typeof record.symptoms === "string" ? record.symptoms : "",
  };
}

// Send a JSON response with the given status code.
function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

// Build a human-readable error payload without exposing stack traces to the browser.
function toUiError(error: unknown): { statusCode: number; payload: InvestigationUiError } {
  if (error instanceof InvestigationInputError) {
    return {
      statusCode: 400,
      payload: {
        error: "Invalid investigation input",
        detail: error.message,
      },
    };
  }

  const reason = error instanceof Error ? error.message : String(error);
  const lower = reason.toLowerCase();
  const ollamaHint =
    lower.includes("ollama") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed");

  return {
    statusCode: 500,
    payload: {
      error: "Investigation failed",
      detail: ollamaHint
        ? "Unable to complete the investigation. Check that Ollama is running and try again."
        : "Unable to complete the investigation. Check the terminal for details and try again.",
    },
  };
}

// Resolve a safe path under the public directory; reject path traversal attempts.
function resolvePublicPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolved;
}

// Serve a static file from the tester public directory.
async function serveStatic(
  requestPath: string,
  response: http.ServerResponse
): Promise<void> {
  const filePath = resolvePublicPath(requestPath);
  if (!filePath) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(data);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

// Handle POST /api/investigate by running the shared investigation pipeline.
async function handleInvestigate(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const input = asFormInput(body);
    console.log("AutoTrace UI: starting investigation");
    console.log(`  Vehicle: ${input.vehicle}`);
    console.log(`  Codes: ${input.codes}`);
    const result = await investigateFromUiInput(input);
    console.log("AutoTrace UI: investigation complete");
    sendJson(response, 200, result);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`AutoTrace UI investigation failed:\n${reason}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    const mapped = toUiError(error);
    sendJson(response, mapped.statusCode, mapped.payload);
  }
}

// Create the local tester HTTP server (static UI + investigation API).
export function createUiServer(): http.Server {
  return http.createServer((request, response) => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";

    void (async () => {
      if (method === "POST" && url.startsWith("/api/investigate")) {
        await handleInvestigate(request, response);
        return;
      }

      if (method === "GET" || method === "HEAD") {
        await serveStatic(url, response);
        return;
      }

      response.writeHead(405, { Allow: "GET, HEAD, POST" }).end("Method not allowed");
    })().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`AutoTrace UI server error:\n${reason}`);
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: "Investigation failed",
          detail: "Unable to complete the investigation. Check the terminal for details and try again.",
        } satisfies InvestigationUiError);
      } else {
        response.end();
      }
    });
  });
}

// Start the local tester UI on PORT (default 3000).
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createUiServer();

  server.listen(port, "127.0.0.1", () => {
    console.log("AutoTrace tester UI");
    console.log("===================");
    console.log(`Open http://localhost:${port} in your browser.`);
    console.log("POST /api/investigate runs the real investigation pipeline.");
  });
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`AutoTrace UI failed to start:\n${reason}`);
    process.exit(1);
  });
}
