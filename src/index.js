const fs = require("fs");
const path = require("path");

// Example: just prints a message for now
console.log("Minecraft process started!");
console.log("Files in current folder:", fs.readdirSync(__dirname));
