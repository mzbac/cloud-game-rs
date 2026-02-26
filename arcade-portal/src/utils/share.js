import { message } from "antd";

export const copyTextToClipboard = async (text) => {
  if (!text) {
    return false;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);

    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand && document.execCommand("copy");

    document.body.removeChild(textarea);
    return Boolean(copied);
  } catch {
    return false;
  }
};

export const shareUrl = async ({ title, url }) => {
  if (!url) {
    return;
  }

  try {
    if (navigator.share) {
      await navigator.share({ title, url });
      return;
    }
  } catch {}

  const copied = await copyTextToClipboard(url);
  if (copied) {
    message.success("Link copied");
    return;
  }

  message.info(url);
};

