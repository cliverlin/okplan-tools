/* Figma Comment Tracker — 영역 이미지 렌더 프록시 (상태 없음) */
const FIGMA = "https://api.figma.com/v1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청" }); }
  const { fileKey, nodeId, token, scale } = body;
  if (!fileKey || !nodeId || !token) return resp(400, { error: "fileKey, nodeId, token 필요" });
  try {
    const url = `${FIGMA}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${encodeURIComponent(scale || 1)}`;
    const r = await fetch(url, { headers: { "X-Figma-Token": token } });
    if (r.status === 401 || r.status === 403) return resp(r.status, { error: "토큰 권한 부족 또는 만료.", auth: true });
    if (!r.ok) return resp(r.status, { error: `이미지 렌더 실패: ${r.status}` });
    const d = await r.json();
    const imgUrl = d && d.images && d.images[nodeId];
    if (!imgUrl) {
      const why = (d && d.err) ? ("렌더 실패: " + d.err)
        : "이 코멘트가 가리키는 노드를 렌더할 수 없어요 (노드가 삭제됐거나 렌더 불가). 다른 코멘트의 위치 보기를 시도해 보세요.";
      return resp(404, { error: why });
    }
    return resp(200, { url: imgUrl });
  } catch (e) { return resp(502, { error: "이미지 요청 실패: " + e.message }); }
};

function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
