import SyAPP from '../../../SyAPP.js'
import SyPM from '../../../SyPM.js'

class SyPM_Config extends SyAPP.Func() {
    constructor(){
        super(
            'sypm',
            async (props) => {
                let uid = props.session.UniqueID

                if(props.processkill){
                    if(SyPM.kill(props.processkill)){
                        await this.WaitLog('',100)
                        SyPM.cleanup()
                        this.Text(uid,this.TextColor.green('Processo removido com sucesso !'))
                    } else {
                        this.Text(uid,this.TextColor.red('Erro ao remover processo'))
                    }
                }

                let processes = SyPM.list()

                
                for(let process of processes){
                    await this.DropDown(uid,process.pid,async () => {

                        //this.Text(uid,`PID : ${process.pid}`)

                        this.Buttons(uid,[
                            {name : 'Restart'},
                            {name : 'Kill',props : {processkill : process.pid}}
                        ])
                    },{down_emoji : '-',up_emoji : '+',up_buttontext :`${(process.status == 'Running') ? this.TextColor.green(process.name) : this.TextColor.red(process.name)}`,down_buttontext :`${(process.status == 'Running') ? this.TextColor.green(process.name) : this.TextColor.red(process.name)}` })
                }
                
                
               
               
                this.Button(uid,{name : '← Return',path : 'config'})
            }
        )
    }
}

export default SyPM_Config