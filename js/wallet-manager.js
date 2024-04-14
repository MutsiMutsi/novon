class WalletManager {
    static CreateNew(password) {
        let wallet = new nkn.Wallet({ password: password });
        const json = wallet.toJSON();
        localStorage.setItem('NKN_WALLET', JSON.stringify(json));
        return json;
    }

    static OpenExisting(password) {
        const json = localStorage.getItem('NKN_WALLET');
        if (json == null) {
            console.error("no existing wallet found");
            return null;
        }

        return nkn.Wallet.fromJSON(json, { password: password });
    }

    static IsExisting() {
        return localStorage.getItem('NKN_WALLET') != null;
    }
}