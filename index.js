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

      //const result = client.db('Any_Name').collection('Any_collection_name').insertOne({Object})
      const existingUser = await users.findOne({ email: userBody.email });

      if (existingUser) {
        return res.status(200).send({
          success: true,
          message: "User already exists",
          insertedId: existingUser._id,
          existing: true,
        });
      }
      const result = await users.insertOne(userBody);

      if (result.acknowledged) {
        return res.status(201).send({
          success: true,
          message: "User added successfully",
          insertedId: result.insertedId,
          existing: false,
        });
      }
      return res.status(400).send({
        success: false,
        message: "User not added",
      });
    });

    // ============== Create companies collection ==============
    app.post("/companies", async (req, res) => {
      const dataBody = req.body;
      const result = await companies.insertOne(dataBody);

      if (result.acknowledged) {
        return res.status(201).send({
          success: true,
          message: "Company added successfully",
          insertedId: result.insertedId,
        });
      }
      return res.status(400).send({
        success: false,
        message: "Company not added",
      });
    });

    // ============== Create companies collection ==============
    app.get("/companies", async (req, res) => {
      const result = await companies
        .find(
          {},
          {
            projection: {
              companyName: 1,
              companyLogo: 1,
              status: 1,
            },
          },
        )
        .toArray();

      res.send(result);
    });

    // ================ Get user role ===============
    app.get("/users/role", async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.status(400).send({
          success: false,
          message: "Email is required",
          role: null,
        });
      }

      const user = await users.findOne({ email });

      if (!user) {
        return res.status(404).send({
          success: false,
          message: "User not found",
          role: null,
        });
      }

      res.send({
        success: true,
        role: user.role,
        user,
      });
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
