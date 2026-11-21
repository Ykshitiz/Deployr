import AWS from "aws-sdk";
import fs from "fs";

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  // endpoint: process.env.AWS_ENDPOINT,
});

export const uploadFiles = async (fileName: string, localFilePath: string) => {
  const fileContent = fs.readFileSync(localFilePath);

  const s3Key = fileName.replace(/\\/g, "/");

  const response = await s3
    .upload({
      Body: fileContent,
      Bucket: process.env.AWS_BUCKET_NAME as string,
      Key: s3Key,
    })
    .promise();

  console.log(response);
  return response;
};
