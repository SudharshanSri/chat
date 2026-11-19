const { MongoClient } = require("mongodb");

const url = "mongodb://127.0.0.1:27017";

const client = new MongoClient(url);

let db;

async function connectDB() {

    try {

        await client.connect();

        db = client.db("chat_app");

        console.log("=================================");
        console.log("✅ MongoDB Connected");
        console.log("Database : chat_app");
        console.log("=================================");

    } catch (err) {

        console.log(err);

    }

}

function getDB() {

    return db;

}

module.exports = {

    connectDB,

    getDB

};