import fs from "fs";
import path from "path";

// Never upload these to S3: .git can be hundreds of MB and node_modules must be
// reinstalled by the build machine anyway.
const SKIP_DIRS = new Set([".git", "node_modules"]);

export const getAllFiles = (folderPath: string): string[] => {
  let response: string[] = [];

  for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
    const fullFilePath = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      response = response.concat(getAllFiles(fullFilePath));
    } else if (entry.isFile()) {
      response.push(fullFilePath);
    }
  }

  return response;
};
