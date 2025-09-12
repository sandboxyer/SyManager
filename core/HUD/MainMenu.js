import Network from '../Network.js'
import HUD from './HUD.js'


const MainMenu = () => {
    let final = {
        title : 'Sy Manager',
        options : [
        {
            name : 'Network',
            action : async () => {
                await Network.Scan({log : true})
                await HUD.pressWait()
                HUD.displayMenu(MainMenu)

            }
        }
        ]
    }


    return final
}

export default MainMenu