const express = require('express')
const app = express()
const port = process.env.PORT || 3000

app.get('/', (req, res) => {
  res.send('Successfully Connected to SupportHub')
})

app.listen(port, () => {
  console.log(`SupportHub server listening on port ${port}`)
})


