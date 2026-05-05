// Test fixture: exit immediately with the code from argv[2] (default 7).
const code = parseInt(process.argv[2] || "7", 10)
process.exit(code)
