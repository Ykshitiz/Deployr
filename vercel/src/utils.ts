import fs from "fs";
import path from "path";
const MAX_LENGTH = 5;

export function generate(){
    let  ans = "";
    const subset = "123456789qwertyuiopalkdjfjhgzmxnvbcs";

    for(let i =0 ;i<MAX_LENGTH;i++){
        ans += subset[Math.floor(Math.random()*subset.length)];
    }
    return ans;

}

export function getAllFiles(dirPath:string) {
    

    const filesAndFolders = fs.readdirSync(dirPath);
    
    let arrayOfFiles:string[] = [];
    
    filesAndFolders.forEach(file=>{
        const fullFilePath  = path.join(dirPath,file);
        if(fs.statSync(fullFilePath).isDirectory()){
            arrayOfFiles = arrayOfFiles.concat(getAllFiles(fullFilePath));
        }else{
            arrayOfFiles.push(fullFilePath);
        }
    })
    
  
    return arrayOfFiles;
  }