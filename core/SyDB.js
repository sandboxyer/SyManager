import C from "./C.js"

class SyDB {
static async Start(){
    await C.run('./new_sydb.c',{args : ['--server']})
    console.log('foi')
    return
}

}

export default SyDB

await SyDB.Start()
