import { app } from "@arkecosystem/core-container";
import { State, TransactionPool } from "@arkecosystem/core-interfaces";
import { Interfaces, Utils } from "@arkecosystem/crypto";
import { Interfaces as StakeInterfaces } from "@nosplatform/stake-transactions-crypto";
import { createHandyClient } from "handy-redis";
import { ExpireHelper } from "./expire";

export class PowerUpHelper {
    public static async powerUp(
        wallet: State.IWallet,
        stakeKey: string,
        walletManager: State.IWalletManager,
    ): Promise<void> {
        const stakes: StakeInterfaces.IStakeArray = wallet.getAttribute("stakes", {});
        const stake: StakeInterfaces.IStakeObject = stakes[stakeKey];
        const stakePower: Utils.BigNumber = wallet.getAttribute("stakePower", Utils.BigNumber.ZERO);
        stakes[stakeKey].active = true;
        wallet.setAttribute("stakes", JSON.parse(JSON.stringify(stakes)));
        wallet.setAttribute("stakePower", stakePower.plus(stake.power));
        if (wallet.hasVoted()) {
            const delegate: State.IWallet = walletManager.findByPublicKey(wallet.getAttribute("vote"));
            const voteBalance: Utils.BigNumber = delegate.getAttribute("delegate.voteBalance", Utils.BigNumber.ZERO);
            const newVoteBalance: Utils.BigNumber = voteBalance.minus(stake.amount).plus(stake.power);
            delegate.setAttribute("delegate.voteBalance", newVoteBalance);
            walletManager.reindex(delegate);
        }
        walletManager.reindex(wallet);
    }

    public static async removePowerUp(stakeKey: string): Promise<void> {
        const redis = createHandyClient();
        await redis.zrem("stake_powerups", `stake:${stakeKey}`);
    }

    public static async processPowerUps(
        block: Interfaces.IBlockData,
        walletManager: State.IWalletManager,
    ): Promise<void> {
        const redis = createHandyClient();
        const lastTime = block.timestamp;
        const keys = await redis.zrangebyscore("stake_powerups", 0, lastTime);
        const stakes = [];
        let stakesCount = 0;
        for (const key of keys) {
            const obj = await redis.hgetall(key);
            stakes.push(obj);
            stakesCount++;
        }
        if (stakes && stakesCount > 0 && stakes.length) {
            app.resolvePlugin("logger").info("Processing stake power-ups.");

            for (const stake of stakes) {
                if (stake && stake.publicKey) {
                    const wallet = walletManager.findByPublicKey(stake.publicKey);
                    if (
                        wallet.hasAttribute("stakes") &&
                        wallet.getAttribute("stakes")[stake.stakeKey] !== undefined &&
                        wallet.getAttribute("stakes")[stake.stakeKey].halved === false &&
                        wallet.getAttribute("stakes")[stake.stakeKey].canceled === false &&
                        wallet.getAttribute("stakes")[stake.stakeKey].active === false
                    ) {
                        app.resolvePlugin("logger").info(
                            `Power-up Stake ${stake.stakeKey} of wallet ${wallet.address}.`,
                        );

                        // Power up in db wallet
                        await this.powerUp(wallet, stake.stakeKey, walletManager);

                        // Power up in pool wallet
                        const poolService: TransactionPool.IConnection = app.resolvePlugin<TransactionPool.IConnection>(
                            "transaction-pool",
                        );
                        const poolWalletManager: State.IWalletManager = poolService.walletManager;
                        await this.powerUp(
                            poolWalletManager.findByPublicKey(wallet.publicKey),
                            stake.stakeKey,
                            poolService.walletManager,
                        );

                        // Remove queued power-up from redis
                        await this.removePowerUp(stake.stakeKey);
                    } else {
                        // If stake isn't found then the chain state has reverted to a point before its stakeCreate, or the stake was already halved.
                        // Delete stake from db in this case
                        app.resolvePlugin("logger").info(
                            `Unknown ${stake.stakeKey} of wallet ${wallet.address}. Deleted from storage.`,
                        );
                        await ExpireHelper.removeExpiry(stake.stakeKey);
                    }
                }
            }
        }
    }
}