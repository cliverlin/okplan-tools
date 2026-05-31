/* Figma Comment Tracker — 댓글 + 파일메타(+필요시 앵커 노드맵) 프록시 (상태 없음)
 * 상태(검토/이력/스냅샷/파일목록)는 클라이언트 localStorage가 관리.
 * 구조는 "댓글이 붙은 앵커 노드"만 반환해 응답을 작게 유지하고, 트리 호출엔 타임아웃 가드를 둔다. */
const FIGMA = "https://api.figma.com/v1";
const TREE_TIMEOUT_MS = 7500; // Netlify 함수 한도(보통 10s) 안에서 안전하게

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청" }); }
  const { fileUrl, token, structLastModified } = body;
  const fileKey = parseFileKey(fileUrl) || (fileUrl || "").trim();
  if (!fileKey) return resp(400, { error: "URL에서 파일 키를 찾을 수 없습니다." });
  if (!token) return resp(400, { error: "Personal Access Token이 필요합니다.", needToken: true });

  const headers = { "X-Figma-Token": token };

  // 1) 댓글 + 2) 파일 메타(depth=1)를 병렬로
  let cRes, fRes;
  try {
    [cRes, fRes] = await Promise.all([
      fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}/comments`, { headers }),
      fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}?depth=1`, { headers }).catch(() => null),
    ]);
  } catch (e) { return resp(502, { error: "Figma 연결 실패: " + e.message }); }

  if (cRes.status === 401 || cRes.status === 403)
    return resp(cRes.status, { error: "토큰이 만료되었거나 유효하지 않습니다. 설정에서 갱신하세요.", auth: true });
  if (cRes.status === 404) return resp(404, { error: "파일을 찾을 수 없습니다. URL을 확인하세요." });
  if (cRes.status === 429) return resp(429, { error: "요청이 많습니다(rate limit). 잠시 후 다시 시도하세요." });
  if (!cRes.ok) return resp(cRes.status, { error: `Figma API 오류: ${cRes.status}` });
  const data = await cRes.json();
  const comments = (data && data.comments) || [];

  let fileName = "", lastModified = "";
  if (fRes && fRes.ok) { try { const fd = await fRes.json(); fileName = fd.name || ""; lastModified = fd.lastModified || ""; } catch {} }

  // 3) 구조: 캐시가 최신이면 생략. 아니면 트리에서 "앵커 노드만" 추출 (작은 응답 + 타임아웃 가드)
  let nodes = null, usedCache = false, structTimedOut = false;
  if (structLastModified && lastModified && structLastModified === lastModified) {
    usedCache = true;
  } else {
    const byId = Object.create(null);
    for (const c of comments) byId[c.id] = c;
    const anchorIds = new Set();
    for (const c of comments) { const a = anchorIdOf(c, byId); if (a) anchorIds.add(a); }
    if (anchorIds.size) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TREE_TIMEOUT_MS);
      try {
        const tRes = await fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}`, { headers, signal: ctrl.signal });
        if (tRes.ok) { const tree = await tRes.json(); nodes = pickAnchorNodes(tree, anchorIds); if (!lastModified) lastModified = tree.lastModified || ""; }
      } catch (e) { structTimedOut = true; } // abort/네트워크 → 저하 모드(댓글은 정상)
      finally { clearTimeout(timer); }
    } else {
      nodes = {}; // 앵커 없는 파일
    }
  }

  return resp(200, { fileKey, fileName, lastModified, usedCache, structTimedOut, nodes, comments });
};

function parseFileKey(url) {
  if (!url) return null;
  const m = String(url).match(/figma\.com\/(?:file|design|board|proto)\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : null;
}
function anchorIdOf(comment, byId) {
  let c = comment, depth = 0;
  while (c && c.parent_id && byId[c.parent_id] && depth < 200) { c = byId[c.parent_id]; depth++; }
  const cm = c && c.client_meta;
  if (!cm) return null;
  if (cm.node_id) return Array.isArray(cm.node_id) ? cm.node_id[0] : cm.node_id;
  return null;
}
// 전체 트리를 순회하되, 앵커 id에 해당하는 노드만 골라 작은 맵으로 반환
function pickAnchorNodes(fileJson, anchorIds) {
  const nodes = Object.create(null);
  const doc = fileJson && fileJson.document;
  if (!doc || !Array.isArray(doc.children)) return nodes;
  let remaining = anchorIds.size;
  for (const page of doc.children) {
    const pageName = page.name || "(이름 없는 페이지)";
    const stack = [page];
    while (stack.length) {
      const n = stack.pop();
      if (!n || !n.id) continue;
      if (anchorIds.has(n.id)) {
        const bb = n.absoluteBoundingBox || {};
        nodes[n.id] = { name: n.name || "(이름 없음)", w: bb.width || 0, h: bb.height || 0, page: pageName };
        remaining--;
      }
      if (Array.isArray(n.children)) for (const ch of n.children) stack.push(ch);
    }
    if (remaining <= 0) break; // 모든 앵커를 찾으면 조기 종료
  }
  return nodes;
}
function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
