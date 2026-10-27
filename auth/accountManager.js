class AccountManager {
  constructor() {
    this.accounts = [];
    this.loadAccounts();
  }

  loadAccounts() {
    // Accounts werden von Frontend gesendet
    // Keine Speicherung auf Server für Sicherheit
  }

  addAccount(name, password, type) {
    this.accounts.push({
      name,
      password,
      type,
      id: Date.now()
    });
  }

  getAccount(id) {
    return this.accounts.find(a => a.id === id);
  }

  getAllAccounts() {
    return this.accounts.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type
    }));
  }

  removeAccount(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
  }
}

module.exports = AccountManager;
