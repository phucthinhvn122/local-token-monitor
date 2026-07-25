import { MonitorDatabase } from "./index.ts";

const database = new MonitorDatabase();
console.log(`Database ready: ${database.path}`);
database.close();
