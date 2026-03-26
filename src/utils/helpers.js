/**
 * Shared helper utilities used across controllers and services.
 */

const MAX_MESSAGE_LENGTH = 2000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Escape special regex characters in a string to prevent ReDoS attacks.
 * @param {string} str - User input to escape
 * @returns {string} Escaped string safe for use in RegExp / $regex
 */
const escapeRegex = (str) => {
  if (typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/**
 * Sanitize message text: trim, truncate, strip dangerous chars.
 * @param {string} text
 * @returns {string}
 */
const sanitizeText = (text) => {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, MAX_MESSAGE_LENGTH).replace(/[<>]/g, "");
};

/**
 * Validate and sanitize an array of attachment objects.
 * Returns only valid attachments within size limits.
 * @param {Array} attachments
 * @returns {Array} Validated attachments
 */
const validateAttachments = (attachments) => {
  if (!Array.isArray(attachments)) return [];

  const valid = [];
  for (const att of attachments) {
    if (
      att.type &&
      att.url &&
      att.name &&
      typeof att.size === "number" &&
      att.mimeType &&
      att.size <= MAX_ATTACHMENT_SIZE
    ) {
      valid.push({
        type: att.type,
        url: att.url,
        name: att.name.slice(0, 255),
        size: att.size,
        mimeType: att.mimeType,
      });
    }
  }
  return valid;
};

module.exports = {
  escapeRegex,
  sanitizeText,
  validateAttachments,
  MAX_MESSAGE_LENGTH,
  MAX_ATTACHMENT_SIZE,
};
