import { createClient } from "redis";
import { downloadS3Folder } from "./aws";
import { buildProject } from "./utils";
import { copyFinalDist } from "./aws";
const subscriber = createClient();
subscriber.on("error", (err) => console.error("Redis Client Error", err));

async function main() {
  await subscriber.connect();

  const blockingClient = subscriber.duplicate();
  await blockingClient.connect();

  while (true) {
    const response = await blockingClient.brPop("build-queue", 0);
    if(response === null || response.element === undefined) {
      console.log("No job received, continuing...");
      continue;
    }
    if(response.element.trim() === "") {
      console.log("invalid id received, continuing...");
    }

    if (response) console.log("Received job:", response.element);
    await downloadS3Folder(`output/${response?.element}`);
    await buildProject(response?.element || "");
    await copyFinalDist(response?.element || "");
  }
}

main();
