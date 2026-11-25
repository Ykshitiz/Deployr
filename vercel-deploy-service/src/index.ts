import { createClient } from "redis";
import { downloadS3Folder, copyFinalDist } from "./aws";
import { buildProject } from "./utils";

const subscriber = createClient();
subscriber.on("error", (err) => console.error("Redis Client Error", err));

async function main() {
  await subscriber.connect();

  const blockingClient = subscriber.duplicate();
  await blockingClient.connect();

  while (true) {
    const response = await blockingClient.brPop("build-queue", 0);
    if (!response || !response.element) {
      console.log("No job received, continuing...");
      continue;
    }

    const id = response.element.trim();
    if (id === "") {
      console.log("Invalid id received, continuing...");
      continue;
    }

    console.log("Received job:", id);
    await downloadS3Folder(`output/${id}`);
    await buildProject(id);
    await copyFinalDist(id);
    console.log("Completed deployment for job:", id);
  }
}

main();
