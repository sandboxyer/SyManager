    import C from "./C.js"
    import SyPM from "./SyPM.js"


    
    class SyDB {
    static async Start(){
        SyPM.run(`import C from "./C.js"

            console.log(process.cwd())
            
         C.run('./util/SyDB.c',{args : ['--server']})
        console.log('C.run() executado, SyDB server ON')    
	`,{workingDir : process.cwd()})
     
	
	console.log('C.run() executado, SyDB server ON')
        return
    }

    }

    export default SyDB

    await SyDB.Start()
