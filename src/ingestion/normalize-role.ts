export function normalizeRole(
  role: string,
): "user" | "assistant" | "system" | "tool" {
  const lower = role.toLowerCase();
  if (
    lower === "user" ||
    lower === "human" ||
    lower === "humanmessage" ||
    lower === "customer"
  )
    return "user";
  if (
    lower === "assistant" ||
    lower === "ai" ||
    lower === "aimessage" ||
    lower === "bot" ||
    lower === "agent"
  )
    return "assistant";
  if (lower === "system" || lower === "systemmessage") return "system";
  if (lower === "tool" || lower === "toolmessage" || lower === "function")
    return "tool";
  return "user";
}
