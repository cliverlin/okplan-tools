/* Figma Comment Tracker — 댓글 + 파일메타(+앵커 노드만) 프록시 (상태 없음)
 * 큰 파일에서 전체 문서를 파싱하면 함수가 OOM으로 killed 되므로,
 * 댓글이 붙은 노드 id만 ?ids=... 로 요청해 "노드 + 루트~노드 경로(페이지)"만 받는다. */
const FIGMA = "https://api.figma.com/v1";
const TREE_TIMEOUT_MS = 8000;   // Netlify 함수 한도(보통 10s) 안에서
const IDS_PER_REQUEST = 120;    // ?ids= URL 길이/응답 크기 제한 대비 청크

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청" }); }
  const { fileUrl, token, structLastModified } = body;
  const fileKey = parseFileKey(fileUrl) || (fileUrl || "").trim();
  if (!fileKey) return resp(400, { error: "URL에서 파일 키를 찾을 수 없습니다." });
  if (!token) return resp(400, { error: "Personal Access Token이 필요합니다.", needToken: true });

  const headers = { "X-Figma-Token": token };

  // 1) 댓글 + 2) 파일 메타(depth=1) 병렬
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

  // 3) 구조: 캐시 최신이면 생략. 아니면 앵커 노드 id만 ?ids= 로 잘라서 받음(메모리 안전).
  let nodes = null, usedCache = false, structTimedOut = false;
  if (structLastModified && lastModified && structLastModified === lastModified) {
    usedCache = true;
  } else {
    const byId = Object.create(null);
    for (const c of comments) byId[c.id] = c;
    const anchorIds = [];
    const seen = new Set();
    for (const c of comments) { const a = anchorIdOf(c, byId); if (a && !seen.has(a)) { seen.add(a); anchorIds.push(a); } }
    if (anchorIds.length) {
      const chunks = [];
      for (let i = 0; i < anchorIds.length; i += IDS_PER_REQUEST) chunks.push(anchorIds.slice(i, i + IDS_PER_REQUEST));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TREE_TIMEOUT_MS);
      try {
        const trees = await Promise.all(chunks.map((ch) =>
          fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(ch.join(","))}`, { headers, signal: ctrl.signal })
            .then((r) => (r.ok ? r.json() : null)).catch(() => null)
        ));
        const merged = Object.create(null);
        let any = false;
        for (const tree of trees) {
          if (!tree) continue;
          any = true;
          pickAnchorNodes(tree, seen, merged);
          if (!lastModified) lastModified = tree.lastModified || "";
        }
        if (any) nodes = merged; else structTimedOut = true;
      } catch (e) { structTimedOut = true; }
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
// ?ids= 로 받은 (가지치기된) 문서를 순회하며 앵커 노드 + 페이지명을 out에 담는다
function pickAnchorNodes(fileJson, wanted, out) {
  const doc = fileJson && fileJson.document;
  if (!doc || !Array.isArray(doc.children)) return out;
  for (const page of doc.children) {
    const pageName = page.name || "(이름 없는 페이지)";
    const stack = [page];
    while (stack.length) {
      const n = stack.pop();
      if (!n || !n.id) continue;
      if (wanted.has(n.id)) {
        const bb = n.absoluteBoundingBox || {};
        out[n.id] = { name: n.name || "(이름 없음)", w: bb.width || 0, h: bb.height || 0, page: pageName };
      }
      if (Array.isArray(n.children)) for (const ch of n.children) stack.push(ch);
    }
  }
  return out;
}
function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
