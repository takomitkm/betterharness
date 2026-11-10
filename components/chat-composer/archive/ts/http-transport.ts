import type { ComposerTransport, DeliveryResult, SendRequest } from "./types.ts";

/**
 * 宿主序列化约定：消息内容顺序 = document.value 中附件节点按出现顺序参与正文，
 * 未被文档引用的附件（rail-only）追加在文档内容之后。这里不重排快照字段，
 * 只把附件条目的 Blob 字节转成 base64（字节本身永不进入 document.value）。
 */
async function encode(request: SendRequest) {
  return {
    ...request,
    snapshot: {
      ...request.snapshot,
      attachments: await Promise.all(request.snapshot.attachments.map(async ({ data, ...file }) => {
        const bytes = new Uint8Array(await data.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        }
        return { ...file, bytes: btoa(binary) };
      })),
    },
  };
}

/** Example HTTP binding. A real host must implement the documented receipt/idempotency contract. */
export function createHttpTransport(baseUrl: string, scenario: () => string = () => "normal"): ComposerTransport {
  return {
    async send(request, { signal }): Promise<DeliveryResult> {
      let payload;
      try { payload = await encode(request); }
      catch (error) {
        return { status: "rejected", reason: `附件读取失败，尚未发出：${String(error)}` };
      }
      const response = await fetch(new URL("api/send", baseUrl), {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", "Idempotency-Key": request.id, "X-Demo-Scenario": scenario() },
        body: JSON.stringify(payload),
      });
      // An HTTP error by itself does not prove non-admission.
      if (!response.ok) return { status: "unknown", reason: `HTTP ${response.status}，送达待确认` };
      return response.json();
    },
    async lookup({ id, scopeId }, { signal }): Promise<DeliveryResult> {
      const url = new URL("api/receipt", baseUrl);
      url.searchParams.set("id", id); url.searchParams.set("scopeId", scopeId);
      const response = await fetch(url, { signal });
      if (!response.ok) return { status: "unknown", reason: "无法取得权威回执" };
      return response.json();
    },
  };
}
