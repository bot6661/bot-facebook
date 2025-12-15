const express = require('express');
const server = express();

server.all('/', (req, res) => res.send("Bot is running on Render!"));

function keepAlive() {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = keepAlive;
