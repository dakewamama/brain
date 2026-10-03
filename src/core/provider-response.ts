import { AxisError } from "../grants/service.js";

/** Bound bytes before parsing untrusted provider JSON, including chunked bodies. */
export async function providerJson(response: Response, maxBytes = 262144): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new AxisError("provider_response_too_large");
  }
  if (!response.body) throw new AxisError("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AxisError("provider_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new AxisError("provider_response_invalid");
  }
}
