import "dotenv/config"; 
import express from "express";
import cors from "cors";
import { generate, getAllFiles } from "./utils";
import { simpleGit } from "simple-git";
import path from "path";
import { uploadFiles } from "./aws";
const app = express();

app.use(cors());
app.use(express.json());
console.log(__dirname);
app.get("/", (req, res) => {
  req.query.name
    ? res.send(`Hello ${req.query.name}`)
    : res.send("Hello World");
});


uploadFiles("kshitij/package.json", path.join(__dirname, "package.json"));

app.post("/deploy", async (req, res) => {
  const repoUrl = req.body.repoUrl;
  const id = generate();
  await simpleGit().clone(repoUrl, path.join(__dirname, `dist/output/${id}`));

  const files = getAllFiles(path.join(__dirname, `dist/output/${id}`));
  console.log(files);
  res.json({ message: `Deploying from ${repoUrl} with id ${id}` });
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
