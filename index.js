const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3021;
const { MongoClient, ServerApiVersion } = require("mongodb");

//middleware
app.use(cors());
app.use(express.json());

// mongodb connection
const uri =
  "mongodb+srv://nknilandu:8ryfXnfOq3jLIZWc@cluster-support-hub.idvmsjp.mongodb.net/?appName=Cluster-Support-Hub";

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get("/", (req, res) => {
  res.send("Successfully Connected to SupportHub");
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    // ++++++++++++++++++++++++++++++++++++++++++++++++

    const DB = client.db("supportHub");
    const users = DB.collection("users");
    const companies = DB.collection("companies");

    // ================  Create users collections ===============
    app.post("/users", async (req, res) => {
      const userBody = req.body;
      const result = await users.insertOne(userBody);
      //const result = client.db('Any_Name').collection('Any_collection_name').insertOne({Object})
      res.send(result);
      console.log("Successfully user added");
    });

    // ============== Create companies collection ==============
    app.post("/companies", async (req, res) => {
      const dataBody = req.body;
      const result = await companies.insertOne(dataBody);
      res.send(result);
      console.log("Successfully company added");
    });




















    

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`SupportHub server listening on port ${port}`);
});
