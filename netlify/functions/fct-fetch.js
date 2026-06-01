/* Figma Comment Tracker — 댓글 + 파일메타(+앵커 노드만) 프록시 (상태 없음)
 * 큰 파일에서 전체 문서를 파싱하면 함수가 OOM으로 killed 되므로,
 * 댓글이 붙은 노드 id만 잘라서 두 갈래로 받는다.
 *  A) /nodes?ids=&depth=1 → 노드명 + 크기(absoluteBoundingBox). depth가 "노드 기준"이라
 *     하위 트리를 안 받아 가볍고 빠름 → 위치(핀)·크기는 큰 파일에서도 항상 확보.
 *  B) /files?ids=배치     → 페이지명(루트~노드 경로 ancestor). 베스트에포트로 병합.
 *     (파일 endpoint의 depth는 "문서 루트 기준"이라 깊은 앵커를 잘라버리므로 쓸 수 없음.
 *      앵커가 큰 프레임이면 하위 트리째 와서 무거워 큰 파일에선 타임아웃될 수 있다.)
 * 주의: id 1개씩 다량 요청하는 "개별 복구"는 토큰 공용 rate limit을 소진시켜
 *       직후의 /images(미리보기 렌더)를 429/지연시키므로 쓰지 않는다(요청 수를 낮게 유지). */
const FIGMA = "https://api.figma.com/v1";
const IDS_PER_REQUEST = 20;       // 페이지용 /files?ids= 배치 청크(작게 → 큰 앵커 1개가 청크 전체를
                                  //  막지 않아 부분 성공률↑. 89앵커≈5요청으로 rate limit 위험 없음)
const NODES_PER_REQUEST = 100;    // /nodes?ids=&depth=1 청크 — 응답이 작아 크게 잡아도 됨
const STRUCT_TIMEOUT_MS = 7000;   // 구조(A+B) 예산 — Netlify 10s 안에서

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

  // 3) 구조: 캐시 최신이면 생략. 아니면 앵커 노드만 두 갈래(A 노드/크기, B 페이지)로 받아 병합.
  let nodes = null, usedCache = false, structTimedOut = false, pagePartial = false;
  if (structLastModified && lastModified && structLastModified === lastModified) {
    usedCache = true;
  } else {
    const byId = Object.create(null);
    for (const c of comments) byId[c.id] = c;
    const anchorIds = [];
    const seen = new Set();
    for (const c of comments) { const a = anchorIdOf(c, byId); if (a && !seen.has(a)) { seen.add(a); anchorIds.push(a); } }
    if (anchorIds.length) {
      const nodeChunks = chunk(anchorIds, NODES_PER_REQUEST);
      const fileChunks = chunk(anchorIds, IDS_PER_REQUEST);
      const merged = Object.create(null);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), STRUCT_TIMEOUT_MS);
      let gotNodes = false, gotFile = false;
      try {
        const [nodeRes, fileRes] = await Promise.all([
          // A) 노드명 + 크기 (가볍고 신뢰도 높음 → 위치/핀은 항상 확보)
          Promise.all(nodeChunks.map((ch) =>
            fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ch.join(","))}&depth=1`, { headers, signal: ctrl.signal })
              .then((r) => (r.ok ? r.json() : null)).catch(() => null)
          )),
          // B) 페이지명 (ancestor 경로에서 추출, 베스트에포트)
          Promise.all(fileChunks.map((ch) =>
            fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(ch.join(","))}`, { headers, signal: ctrl.signal })
              .then((r) => (r.ok ? r.json() : null)).catch(() => null)
          )),
        ]);
        for (const nr of nodeRes) {
          const map = nr && nr.nodes;
          if (!map) continue;
          for (const id of Object.keys(map)) {
            const doc = map[id] && map[id].document;
            if (!doc) continue;
            const bb = doc.absoluteBoundingBox || {};
            merged[id] = { name: doc.name || "(이름 없음)", w: bb.width || 0, h: bb.height || 0, page: "" };
            gotNodes = true;
          }
        }
        for (const tree of fileRes) {
          if (!tree) continue;
          gotFile = true;
          pickAnchorNodes(tree, seen, merged);
          if (!lastModified) lastModified = tree.lastModified || "";
        }
      } catch (e) { /* 부분 성공분은 merged에 남음 */ }
      finally { clearTimeout(timer); }

      if (gotNodes || gotFile) {
        nodes = merged;
        // 페이지가 비어있는 앵커가 하나라도 있으면 부분 생략으로 표시(위치/크기는 A에서 확보됨)
        for (const id of anchorIds) { if (!merged[id] || !merged[id].page) { pagePartial = true; break; } }
      } else {
        structTimedOut = true;
      }
    } else {
      nodes = {}; // 앵커 없는 파일
    }
  }

  return resp(200, { fileKey, fileName, lastModified, usedCache, structTimedOut, pagePartial, nodes, comments });
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
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
// ?ids= 로 받은 (가지치기된) 문서를 순회하며 앵커 노드의 페이지명을 out에 병합한다
// (이름/크기는 /nodes 쪽에서 이미 받았을 수 있으므로 기존 값을 보존하고 page만 채운다)
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
        const prev = out[n.id] || {};
        out[n.id] = {
          name: prev.name || n.name || "(이름 없음)",
          w: prev.w || bb.width || 0,
          h: prev.h || bb.height || 0,
          page: pageName,
        };
      }
      if (Array.isArray(n.children)) for (const ch of n.children) stack.push(ch);
    }
  }
  return out;
}
function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
