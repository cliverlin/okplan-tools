/* Figma Comment Tracker — 댓글 + 파일메타(+필요시 트리) 프록시 (상태 없음)
 * 상태(검토/이력/스냅샷/파일목록)는 클라이언트 localStorage가 관리.
 * 구조(노드맵)는 클라이언트가 lastModified 기준으로 캐시하고, 바뀐 경우에만 트리를 요청. */
const FIGMA = "https://api.figma.com/v1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청" }); }
  const { fileUrl, token, structLastModified } = body;
  const fileKey = parseFileKey(fileUrl) || (fileUrl || "").trim();
  if (!fileKey) return resp(400, { error: "URL에서 파일 키를 찾을 수 없습니다." });
  if (!token) return resp(400, { error: "Personal Access Token이 필요합니다.", needToken: true });

  const headers = { "X-Figma-Token": token };

  // 1) 댓글
  let cRes;
  try { cRes = await fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}/comments`, { headers }); }
  catch (e) { return resp(502, { error: "Figma 연결 실패: " + e.message }); }
  if (cRes.status === 401 || cRes.status === 403)
    return resp(cRes.status, { error: "토큰이 만료되었거나 유효하지 않습니다. 설정에서 갱신하세요.", auth: true });
  if (cRes.status === 404) return resp(404, { error: "파일을 찾을 수 없습니다. URL을 확인하세요." });
  if (cRes.status === 429) return resp(429, { error: "요청이 많습니다(rate limit). 잠시 후 다시 시도하세요." });
  if (!cRes.ok) return resp(cRes.status, { error: `Figma API 오류: ${cRes.status}` });
  const data = await cRes.json();
  const comments = (data && data.comments) || [];

  // 2) 파일 메타(이름 + lastModified) — depth=1로 가볍게
  let fileName = "", lastModified = "";
  try {
    const fRes = await fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}?depth=1`, { headers });
    if (fRes.ok) { const fd = await fRes.json(); fileName = fd.name || ""; lastModified = fd.lastModified || ""; }
  } catch { /* non-fatal */ }

  // 3) 구조: 클라이언트 캐시가 최신이면 트리 호출 생략
  let nodes = null, usedCache = false;
  if (structLastModified && lastModified && structLastModified === lastModified) {
    usedCache = true;
  } else {
    try {
      const tRes = await fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}`, { headers });
      if (tRes.ok) { const tree = await tRes.json(); nodes = buildNodeMap(tree); if (!lastModified) lastModified = tree.lastModified || ""; }
    } catch { /* non-fatal — 클라이언트가 캐시로 폴백 */ }
  }

  return resp(200, { fileKey, fileName, lastModified, usedCache, nodes, comments });
};

function parseFileKey(url) {
  if (!url) return null;
  const m = String(url).match(/figma\.com\/(?:file|design|board|proto)\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : null;
}
function buildNodeMap(fileJson) {
  const nodes = Object.create(null);
  const doc = fileJson && fileJson.document;
  if (!doc || !Array.isArray(doc.children)) return nodes;
  for (const page of doc.children) {
    const pageName = page.name || "(이름 없는 페이지)";
    const stack = [page];
    while (stack.length) {
      const n = stack.pop();
      if (!n || !n.id) continue;
      const bb = n.absoluteBoundingBox || {};
      nodes[n.id] = { name: n.name || "(이름 없음)", w: bb.width || 0, h: bb.height || 0, page: pageName };
      if (Array.isArray(n.children)) for (const ch of n.children) stack.push(ch);
    }
  }
  return nodes;
}
function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
