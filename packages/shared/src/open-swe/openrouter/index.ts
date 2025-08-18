export class OpenRouterKeyManager {
  private keys: string[];
  private currentIndex = 0;
  private usedAllKeys = false;

  constructor(keys: string[]) {
    if (!keys || keys.length === 0) {
      throw new Error("No OpenRouter API keys provided.");
    }
    this.keys = keys;
  }

  public getNextKey(): string {
    return this.keys[this.currentIndex];
  }

  public rotateKey(): void {
    if (this.currentIndex < this.keys.length - 1) {
      this.currentIndex++;
    } else {
      this.usedAllKeys = true;
    }
  }

  public isAllKeysUsed(): boolean {
    return this.usedAllKeys;
  }

  public getKeys(): string[] {
    return this.keys;
  }
}
