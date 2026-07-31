const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// This configuration forces Render to accept the external connection
const client = new Client({
    connectionString: "postgresql://faizal:CeTBtmLZ53zc8WAjiWVBUxvneuddYYsG@dpg-d9m3g4l6ub7c73ca14a0-a.oregon-postgres.render.com/bike_auction",
    ssl: { rejectUnauthorized: false } // <-- This is the magic line that bypasses the block
});

async function runSeed() {
    try {
        console.log("Connecting to Render Database (with SSL bypass)...");
        await client.connect();
        
        console.log("Reading schema.sql...");
        // This targets the database folder located one level up from backend
        const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql'); 
        const sql = fs.readFileSync(schemaPath, 'utf8');
        
        console.log("Executing SQL...");
        await client.query(sql);
        
        console.log("✅ SUCCESS! All tables created.");
    } catch (err) {
        console.error("❌ Failed:", err.message);
    } finally {
        await client.end();
    }
}

runSeed();