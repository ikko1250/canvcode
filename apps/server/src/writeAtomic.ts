import { rename, rm, writeFile } from 'node:fs/promises'

// 一時ファイル（temp）に書いてから名前を変えて path に置く（書きかけのファイルが path に残らない。MAI-13）。
// 書き込みか名前の変更に失敗したら（ディスクがいっぱい、など）一時ファイルを消してから投げる。
// 消さないと、書きかけの .tmp が誰にも片付けられずに残り続ける
export async function writeViaTemp(temp: string, path: string, data: string | Uint8Array): Promise<void> {
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
