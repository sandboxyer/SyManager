import SyAPP from '../../../SyAPP.js'
import SyDB from '../../../SyDB.js'

class SyDB_Func extends SyAPP.Func() {
    constructor(){
        super(
            'sydb',
            async (props) => {
                let uid = props.session.UniqueID

                let extra_message = ''

                if(props.inputValue){
                    if(props.new_db_name){
                        await SyDB.createDatabase(props.inputValue)
                        .then(async e => {
                            if(e.success){
                                extra_message = ` | ${this.TextColor.green(`Database ${this.TextColor.yellow(props.inputValue)} ${this.TextColor.green('created successfully!')}`)}`
                            } else {    
                                extra_message = ` | ${this.TextColor.red(`Database creation error`)}`
                            }
                        })
                        .catch(e => {
                            extra_message = ` | ${this.TextColor.red(`Database intern creation error`)}`
                        })
                    }
                  
                }
                

                if(props.new_db){
                    this.WaitInput(uid,{props : {new_db_name : true},question : 'Database Name : '})
                    
                }

                let databases = await SyDB.listDatabases()
                if(databases.success){
                    this.Text(uid,`Databases(${databases.databases.length})${extra_message}`)
                    databases.databases.forEach(e => {
                        this.Button(uid,{name : e})
                    })
                }


                this.Button(uid,{name : this.TextColor.orange('＋ New Database'),props : {new_db : true}})

                this.Button(uid,{name : '← Return',path : 'config'})

            },
            {linked : []}
        )
    }
}

export default SyDB_Func