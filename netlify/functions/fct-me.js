/* Figma Comment Tracker — 토큰 검증 프록시 (상태 없음) */
const FIGMA = "https://api.figma.com/v1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청" }); }
  const { token } = body;
  if (!token) return resp(400, { error: "토큰이 필요합니다." });
  try {
    const r = await fetch(`${FIGMA}/me`, { headers: { "X-Figma-Token": token } });
    if (r.status === 401 || r.status === 403)
      return resp(r.status, { error: "토큰이 유효하지 않습니다.", auth: true });
    if (!r.ok) return resp(r.status, { error: `Figma 오류: ${r.status}` });
    const d = await r.json();
    return resp(200, { handle: d.handle || d.email || "연결됨", email: d.email || "" });
  } catch (e) { return resp(502, { error: "연결 실패: " + e.message }); }
};

function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
