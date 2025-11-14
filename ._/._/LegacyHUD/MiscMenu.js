    import HUD from '../../../SyManager.js' 
    import ClipInstaller from '../._/Util/clip.js'
    import MainMenu from './MainMenu.js'
    import System from '../._/Util/System.js'

    const MiscMenu = async () => {
        let final = {
            title : 'Sy Manager > Misc Menu',
            options : []
        }


        if(System({detectLinuxDistribution : true}) == "ubuntu"){
            final.options.push({
                name : 'Install ClipBoard Aux',
                action : async () => {
                const installer = new ClipInstaller
                await installer.install()
                await HUD.pressWait()
                HUD.displayMenu(MiscMenu)
            }
            })
            }
    
        final.options.push({
            name : '<- Voltar',
            action : () => {
            HUD.displayMenu(MainMenu)
        }
        })

    
        return final
    }


    export default MiscMenu
