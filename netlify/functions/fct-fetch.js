/* Figma Comment Tracker — 댓글 + 파일메타(+앵커 노드만) 프록시 (상태 없음)
 * 큰 파일에서 전체 문서를 파싱하면 함수가 OOM으로 killed 되므로,
 * 댓글이 붙은 노드 id만 잘라서 받는다. 세 갈래로 "항상" 위치·페이지를 확보한다.
 *  A) /nodes?ids=&depth=1   → 노드명 + 크기(absoluteBoundingBox). depth가 "노드 기준"이라
 *     하위 트리를 안 받아 가볍고 빠름 → 위치(핀)·크기는 큰 파일에서도 항상 확보.
 *  B) /files?ids=배치       → 페이지명(루트~노드 경로 ancestor). 정상 파일은 여기서 다 채워짐.
 *     (파일 endpoint의 depth는 "문서 루트 기준"이라 배치에 depth를 못 씀 → 하위 트리째 와서 무거움)
 *  C) /files?ids=<단일>&depth=1 → B에서 빠진 앵커만 1개씩 복구. ids로 ancestor 경로만 남고
 *     depth=1이 페이지 레벨에서 잘라 "그 노드의 페이지 하나"만 작게 옴 → 큰 파일에서도 안전. */
const FIGMA = "https://api.figma.com/v1";
const IDS_PER_REQUEST = 50;     // 페이지용 /files?ids= 배치 청크
const NODES_PER_REQUEST = 100;  // /nodes?ids=&depth=1 청크 — 응답이 작아 크게 잡아도 됨
const AB_TIMEOUT_MS = 4000;     // 1차(A 노드/크기 + B 페이지 배치) 예산
const STRUCT_BUDGET_MS = 8000;  // 구조 전체 예산(1차 + C 페이지 개별 복구), Netlify 10s 안에서
const PAGE_RECOVER_POOL = 12;   // C 개별 복구 동시 요청 수
const PAGE_RECOVER_MAX = 400;   // C 폭주 방지 상한(초과분은 페이지 비움)

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
      const startedAt = Date.now();
      let gotNodes = false, gotFile = false;

      // 1차: A(노드명/크기) + B(페이지 배치) 병렬 — 짧은 예산으로
      const ctrlAB = new AbortController();
      const timerAB = setTimeout(() => ctrlAB.abort(), AB_TIMEOUT_MS);
      try {
        const [nodeRes, fileRes] = await Promise.all([
          Promise.all(nodeChunks.map((ch) =>
            fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ch.join(","))}&depth=1`, { headers, signal: ctrlAB.signal })
              .then((r) => (r.ok ? r.json() : null)).catch(() => null)
          )),
          Promise.all(fileChunks.map((ch) =>
            fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(ch.join(","))}`, { headers, signal: ctrlAB.signal })
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
      finally { clearTimeout(timerAB); }

      // 2차(C): 페이지가 빠진 앵커만 1개씩 복구(?ids=<id>&depth=1 → 페이지 노드 하나만 작게)
      let missing = anchorIds.filter((id) => !merged[id] || !merged[id].page);
      if (missing.length > PAGE_RECOVER_MAX) missing = missing.slice(0, PAGE_RECOVER_MAX);
      const remain = STRUCT_BUDGET_MS - (Date.now() - startedAt);
      if (missing.length && remain > 800) {
        const ctrlRec = new AbortController();
        const timerRec = setTimeout(() => ctrlRec.abort(), remain);
        try { gotFile = (await recoverPages(fileKey, headers, missing, merged, ctrlRec.signal)) || gotFile; }
        catch (e) { /* 복구 실패분은 페이지 비움 — graceful */ }
        finally { clearTimeout(timerRec); }
      }

      if (gotNodes || gotFile || Object.keys(merged).length) {
        nodes = merged;
        // 그래도 페이지가 비어있는 앵커가 하나라도 있으면 부분 생략으로 표시
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
// C단계: 페이지가 빠진 앵커를 id 1개씩 ?ids=<id>&depth=1 로 받아 페이지명만 채운다.
// 응답이 작아 큰 파일에서도 안전. 동시요청 풀 + 429(rate limit) 시 중단. 반환=하나라도 성공 여부.
async function recoverPages(fileKey, headers, ids, out, signal) {
  let i = 0, stop = false, any = false;
  async function worker() {
    while (i < ids.length && !stop) {
      const id = ids[i++];
      let r;
      try {
        r = await fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(id)}&depth=1`, { headers, signal });
      } catch { return; } // abort/네트워크 → 워커 종료
      if (r.status === 429) { stop = true; return; } // rate limit → 전체 중단
      if (!r.ok) continue;
      let tree; try { tree = await r.json(); } catch { continue; }
      const pageName = soloPageName(tree);
      if (pageName) {
        const prev = out[id] || { name: "(이름 없음)", w: 0, h: 0 };
        if (!prev.page) { out[id] = { name: prev.name, w: prev.w, h: prev.h, page: pageName }; any = true; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGE_RECOVER_POOL, ids.length) }, worker));
  return any;
}
// 단일 id + depth=1 응답에서 페이지명을 안전하게 추출.
// ancestor 페이지가 정확히 하나일 때만 신뢰(여러 개로 모호하면 채우지 않음 → 오답 방지).
function soloPageName(tree) {
  const doc = tree && tree.document;
  if (!doc || !Array.isArray(doc.children) || doc.children.length !== 1) return "";
  const page = doc.children[0];
  return page ? (page.name || "(이름 없는 페이지)") : "";
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
