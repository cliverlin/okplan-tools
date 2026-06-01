/* Figma Comment Tracker — 앵커 노드 1개의 "페이지명"만 해석 (상태 없음)
 * 큰 파일에서 전체 페이지를 한 번에 못 받을 때, 클라이언트가 화면에 보이는 코멘트의
 * 앵커만 저부하(낮은 동시성)로 순차 호출 → rate limit 폭주 없이 페이지를 점진적으로 채운다.
 *  1) /files?ids=<id>&depth=1 : ancestor 경로만 남고 페이지 레벨에서 잘려 응답이 작음(빠름).
 *     - 페이지가 하나만 오면 그게 그 노드의 페이지. (노드 자체는 depth로 잘려 안 보일 수 있음)
 *  2) 못 찾으면 /files?ids=<id> (depth 없이) 재시도 — 트리에서 노드를 직접 찾아 페이지 확정(신뢰). */
const FIGMA = "https://api.figma.com/v1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청" }); }
  const { fileKey, nodeId, token } = body;
  if (!fileKey || !nodeId || !token) return resp(400, { error: "fileKey, nodeId, token 필요" });
  const headers = { "X-Figma-Token": token };
  try {
    let page = await pageOf(fileKey, nodeId, headers, true);
    if (!page) page = await pageOf(fileKey, nodeId, headers, false);
    return resp(200, { nodeId, page: page || "" });
  } catch (e) {
    if (e && e.code === 429) return resp(429, { error: "요청이 많습니다(rate limit)." });
    if (e && e.code === 401) return resp(401, { error: "토큰이 만료되었거나 유효하지 않습니다.", auth: true });
    return resp(502, { error: "페이지 조회 실패: " + e.message });
  }
};

async function pageOf(fileKey, nodeId, headers, withDepth) {
  const url = `${FIGMA}/files/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}` + (withDepth ? "&depth=1" : "");
  const r = await fetch(url, { headers });
  if (r.status === 429) { const e = new Error("429"); e.code = 429; throw e; }
  if (r.status === 401 || r.status === 403) { const e = new Error("auth"); e.code = 401; throw e; }
  if (!r.ok) return "";
  let j; try { j = await r.json(); } catch { return ""; }
  return findPage(j, nodeId);
}

function findPage(fileJson, wantId) {
  const doc = fileJson && fileJson.document;
  if (!doc || !Array.isArray(doc.children)) return "";
  for (const page of doc.children) {
    const pageName = page.name || "(이름 없는 페이지)";
    const stack = [page];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if (n.id === wantId) return pageName;           // 노드를 직접 찾음 → 그 페이지 확정
      if (Array.isArray(n.children)) for (const ch of n.children) stack.push(ch);
    }
  }
  // depth=1로 노드가 잘려 못 찾았지만 페이지가 하나뿐이면 그 페이지로 간주
  if (doc.children.length === 1) return doc.children[0].name || "(이름 없는 페이지)";
  return "";
}

function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
