    import C from "./C.js"
    import SyPM from "./SyPM.js"


    
    class SyDB {
    static async Start(){
        SyPM.run(`import C from "./C.js"

            console.log(process.cwd())
            
         console.log(await C.run('./new_sydb.c',{args : ['--server']}))
            `,{workingDir : process.cwd()})
    
        return
    }

    }

    export default SyDB

    await SyDB.Start()
