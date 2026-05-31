/* Figma Comment Tracker — 답글 작성 프록시 (상태 없음, 쓰기 권한 토큰 필요) */
const FIGMA = "https://api.figma.com/v1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "POST only" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { error: "잘못된 요청" }); }
  const { fileKey, token, commentId, message } = body;
  if (!fileKey || !token || !commentId || !message)
    return resp(400, { error: "fileKey, token, commentId, message 필요" });
  try {
    const r = await fetch(`${FIGMA}/files/${encodeURIComponent(fileKey)}/comments`, {
      method: "POST",
      headers: { "X-Figma-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ message, comment_id: commentId }),
    });
    if (r.status === 401 || r.status === 403)
      return resp(r.status, { error: "댓글 쓰기 권한이 있는 토큰이 필요합니다.", auth: true });
    if (!r.ok) return resp(r.status, { error: `답글 등록 실패: ${r.status}` });
    const c = await r.json();
    return resp(200, {
      reply: {
        id: String(c.id),
        parent_id: c.parent_id || commentId,
        author: (c.user && c.user.handle) || "나",
        created_at: c.created_at || new Date().toISOString(),
        message: c.message || message,
      },
    });
  } catch (e) { return resp(502, { error: "답글 요청 실패: " + e.message }); }
};

function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
