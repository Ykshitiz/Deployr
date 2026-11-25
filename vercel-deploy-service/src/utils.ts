import { exec } from "child_process";
import path from "path";

export function buildProject(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const projectDir = path.join(__dirname, `output/${id}`);
    const child = exec("npm install && npm run build", { cwd: projectDir });

    child.stdout?.on("data", (data) => {
      console.log("stdout: " + data);
    });
    child.stderr?.on("data", (data) => {
      console.log("stderr: " + data);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Build failed with exit code ${code}`));
      }
    });
  });
}
