/** @type {import('next').NextConfig} */
export default {
  // node:sqlite is a built-in; keep it external so Next doesn't try to bundle it.
  serverExternalPackages: ["node:sqlite"],
};
