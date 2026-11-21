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
