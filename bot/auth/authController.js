const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AuthController {
  constructor() {
    this.usersFile = path.join(__dirname, '../users.json');
    this.loadUsers();
  }

  loadUsers() {
    if (fs.existsSync(this.usersFile)) {
      const data = fs.readFileSync(this.usersFile, 'utf-8');
      this.users = JSON.parse(data);
    } else {
      // Default User
      this.users = [
        { username: 'admin', password: this.hashPassword('admin123') }
      ];
      this.saveUsers();
    }
  }

  saveUsers() {
    fs.writeFileSync(this.usersFile, JSON.stringify(this.users, null, 2));
  }

  hashPassword(pwd) {
    return crypto.createHash('sha256').update(pwd).digest('hex');
  }

  login(username, password) {
    const user = this.users.find(u => u.username === username);
    if (user && user.password === this.hashPassword(password)) {
      return crypto.randomBytes(32).toString('hex');
    }
    return null;
  }
}

module.exports = AuthController;
